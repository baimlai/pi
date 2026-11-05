    // 导出HTML的浏览器查看器：读取内嵌会话，建分支树/筛选/聊天正文，提供复制链接、JSONL下载及侧栏交互；不调用模型或重新执行历史工具。
    // 这是手写JavaScript而非TypeScript，数据没有接口自动检查；依赖template.html中的DOM和已加载的marked/CJK插件/hljs全局对象。
    // 外层立即执行函数隔离大部分变量，下载函数特意挂window供HTML按钮使用；base64只是编码，全部分支/隐藏内容仍可从文件读取。
    (function() {
      'use strict';

      // ============================================================
      // DATA LOADING
      // ============================================================

      // 从固定script节点读取文本，不把base64当HTML执行；依赖导出器保证节点/数据格式，不对任意坏文件全面容错。
      const base64 = document.getElementById('session-data').textContent;
      // atob得到字节值对应的“二进制字符串”，不能直接当UTF8中文正文。
      const binary = atob(base64);
      // Uint8Array一项一字节，将atob字符码还原为原JSON的UTF8字节。
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      // TextDecoder再还原中文/emoji，最后解析JSON；格式错误可中止本次页面初始化，不会自动修复会话。
      const data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      // 对象解构取内嵌字段，leafId:defaultLeafId把同一字段在本地重命名；entries是全历史而非当前模型消息。
      const { header, entries, leafId: defaultLeafId, systemPrompt, tools, renderedTools } = data;

      // ============================================================
      // URL PARAMETER HANDLING
      // ============================================================

      // Parse URL parameters for deep linking: leafId and targetId
      // Check for injected params (when loaded in iframe via srcdoc) or use window.location
      // iframe宿主可通过meta注入查询文字，否则从当前地址读取；宿主注入值并非自动授予安全/可信保证。
      const injectedParams = document.querySelector('meta[name="pi-url-params"]');
      // substring(1)去location.search的?；meta存在时优先用其content，不合并两份参数。
      const searchString = injectedParams ? injectedParams.content : window.location.search.substring(1);
      // 浏览器按URL查询规则解码参数；get缺键返回null，空值返回空串。
      const urlParams = new URLSearchParams(searchString);
      const urlLeafId = urlParams.get('leafId');
      const urlTargetId = urlParams.get('targetId');
      // Use URL leafId if provided, otherwise fall back to session default
      // ||把空串也视为未指定；这里只选id，不验证它确实存在于会话中。
      const leafId = urlLeafId || defaultLeafId;

      // ============================================================
      // DATA STRUCTURES
      // ============================================================

      // Entry lookup by ID
      // Map按id建索引，重复id后写覆盖；const禁止重赋变量，不禁止set修改Map。
      const byId = new Map();
      for (const entry of entries) {
        byId.set(entry.id, entry);
      }

      // Tool call lookup (toolCallId -> {name, arguments})
      // 为树上toolResult反查调用名字/参数；索引跨全部分支，重复toolCallId同样以后者覆盖，不执行工具。
      const toolCallMap = new Map();
      for (const entry of entries) {
        // &&先确定message类型才访问其message字段，随后只扫描助手数组内容中的toolCall块。
        if (entry.type === 'message' && entry.message.role === 'assistant') {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'toolCall') {
                toolCallMap.set(block.id, { name: block.name, arguments: block.arguments });
              }
            }
          }
        }
      }

      // Label lookup (entryId -> label string)
      // Labels are stored in 'label' entries that reference their target via targetId
      // 单独label条目映射回目标id；当前实现只记真值标签，后续空标签不会删除先前已记标签。
      const labelMap = new Map();
      for (const entry of entries) {
        if (entry.type === 'label' && entry.targetId && entry.label) {
          labelMap.set(entry.targetId, entry.label);
        }
      }

      // ============================================================
      // TREE DATA PREPARATION (no DOM, pure data)
      // ============================================================

      /**
       * Build tree structure from flat entries.
       * Returns array of root nodes, each with { entry, children, label }.
       */
      // 无输入，用全局entries和labelMap建立新树，返回根节点数组；不改条目、不碰DOM，子数组按时间排序。
      // 例如A→B/C建两个孩子；缺父节点、无parent或自引用都作为根。只处理自环，不验证任意多节点环/重复id。
      function buildTree() {
        // 每次新建节点包装与children数组，entry本体仍共享内嵌数据对象。
        const nodeMap = new Map();
        const roots = [];

        // Create nodes
        for (const entry of entries) {
          // id为Map键；label是创建树时查得的值，并非活的绑定。
          nodeMap.set(entry.id, {
            entry,
            children: [],
            label: labelMap.get(entry.id)
          });
        }

        // Build parent-child relationships
        for (const entry of entries) {
          // 第二遍连边，允许父记录出现在文件更后面。
          const node = nodeMap.get(entry.id);
          if (entry.parentId === null || entry.parentId === undefined || entry.parentId === entry.id) {
            roots.push(node);
          } else {
            // 有父则加入其children，缺父作为孤立根保留，避免简单丢弃条目。
            const parent = nodeMap.get(entry.parentId);
            if (parent) {
              parent.children.push(node);
            } else {
              roots.push(node);
            }
          }
        }

        // Sort children by timestamp. Iterative: long sessions form chains deeper than the JS call stack.
        // 迭代所有节点代替深递归，长会话链不消耗同样深的函数调用栈；无效日期产生NaN，不额外修正顺序。
        for (const node of nodeMap.values()) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
        }

        return roots;
      }

      /**
       * Build set of entry IDs on path from root to target.
       */
      // 输入目标id，沿byId父链返回当前路径id集合，无DOM/I/O；例如C父B父A得到{C,B,A}，未知目标为空集合。
      // 缺父/自引用终止，未用visited排除任意两节点环；不能声称对任意损坏历史都可结束。
      function buildActivePathIds(targetId) {
        const ids = new Set();
        let current = byId.get(targetId);
        while (current) {
          // Set去重只影响结果集合，循环本身仍按parentId前进。
          ids.add(current.id);
          // Stop if no parent or self-referencing (root)
          if (!current.parentId || current.parentId === current.id) {
            break;
          }
          current = byId.get(current.parentId);
        }
        return ids;
      }

      /**
       * Get array of entries from root to target (the conversation path).
       */
      // 输入目标id，回溯父链再反转，返回根到目标的条目引用数组，不应用压缩/context_edit，不改原数据。
      // 例如C→B→A返回[A,B,C]，不是所有分支；缺父/自环会停止，其他环没有通用保护。
      function getPath(targetId) {
        const path = [];
        let current = byId.get(targetId);
        while (current) {
          path.push(current);
          // Stop if no parent or self-referencing (root)
          if (!current.parentId || current.parentId === current.id) {
            break;
          }
          current = byId.get(current.parentId);
        }
        // reverse原地反转本函数新数组，不颠倒全局entries。
        return path.reverse();
      }

      // Tree node lookup for finding leaves
      // 首次找叶才建缓存，后续复用；页面数据默认固定，没有跟踪entries修改的失效机制。
      let treeNodeMap = null;

      /**
       * Find the newest leaf node reachable from a given node.
       * This allows clicking any node in a branch to show the full branch.
       * Children are sorted by timestamp, so the newest is always last.
       */
      // 输入任意节点id，返回沿“每层最后一个孩子”走到的叶id，无DOM；第一次会构造treeNodeMap。
      // 例如根有时间1的B、时间2的C，就先走C再选C的最后孩子；是逐层贪心，不比较B/C所有后代叶的全局最新时间。
      function findNewestLeaf(nodeId) {
        // Build tree node map lazily
        if (!treeNodeMap) {
          treeNodeMap = new Map();
          // ...复制根数组，显式栈遍历所有可达节点，避免深递归；假设是正常无环树。
          const stack = [...buildTree()];
          while (stack.length > 0) {
            const node = stack.pop();
            treeNodeMap.set(node.entry.id, node);
            for (const child of node.children) stack.push(child);
          }
        }

        const node = treeNodeMap.get(nodeId);
        // 未知id原样返回，不在这里改成默认叶或报错。
        if (!node) return nodeId;

        // Follow the newest (last) child at each level
        let current = node;
        while (current.children.length > 0) {
          current = current.children[current.children.length - 1];
        }
        return current.entry.id;
      }

      /**
       * Flatten tree into list with indentation and connector info.
       * Returns array of { node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots }.
       * Matches tree-selector.ts logic exactly.
       */
      // 输入根节点和当前路径集合，返回带缩进/连线信息的新包装列表；不改entries，不操作DOM。
      // 先迭代后序计算哪些子树含当前路径，再深度优先展开，让活跃分支优先；单子链保持平坦，分叉及其首代加缩进。
      // 例如A仅有B，默认同缩进；A分B/C时子级多一层。原English的“exactly”描述布局目标，不代表浏览器具备TUI的所有折叠/导航行为。
      function flattenTree(roots, activePathIds) {
        const result = [];
        // 多根模拟虚拟共同根，后续会把它的占位缩进从实际展示减掉。
        const multipleRoots = roots.length > 1;

        // Mark which subtrees contain the active leaf
        // Iterative post-order: long sessions form chains deeper than the JS call stack.
        // Map用节点对象作键，postOrder先收父再收后代，倒序处理时孩子已算好。
        const containsActive = new Map();
        const postOrder = [];
        const pending = [...roots];
        while (pending.length > 0) {
          const node = pending.pop();
          // pending是LIFO栈，显式push孩子代替函数自调用。
          postOrder.push(node);
          for (const child of node.children) pending.push(child);
        }
        for (let i = postOrder.length - 1; i >= 0; i--) {
          const node = postOrder[i];
          // 当前id活跃或任一子树活跃，都让本子树得到true。
          containsActive.set(
            node,
            activePathIds.has(node.entry.id) || node.children.some(child => containsActive.get(child))
          );
        }

        // Stack: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
        const stack = [];

        // Add roots (prioritize branch containing active leaf)
        // 先复制再sort，不改原roots；Number(true/false)变1/0，使活跃者排前。
        const orderedRoots = [...roots].sort((a, b) =>
          Number(containsActive.get(b)) - Number(containsActive.get(a))
        );
        for (let i = orderedRoots.length - 1; i >= 0; i--) {
          const isLast = i === orderedRoots.length - 1;
          // 元组按下方解构顺序携带布局状态；倒着压栈让正序项先出栈。
          stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
        }

        while (stack.length > 0) {
          // 数组解构取这一项的7份状态，pop只修改本地待处理栈。
          const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();

          // 属性简写生成新展示记录，node/已有gutters可能共享引用，但此处不原地改旧gutters。
          result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots });

          const children = node.children;
          const multipleChildren = children.length > 1;

          // Order children (active branch first)
          // 仅为展示重排副本，buildTree的children时间顺序仍留给findNewestLeaf使用。
          const orderedChildren = [...children].sort((a, b) =>
            Number(containsActive.get(b)) - Number(containsActive.get(a))
          );

          // Calculate child indent (matches tree-selector.ts)
          // let让三个互斥分支各自赋值；justBranched表示上一层发生分叉。
          let childIndent;
          if (multipleChildren) {
            // Parent branches: children get +1
            childIndent = indent + 1;
          } else if (justBranched && indent > 0) {
            // First generation after a branch: +1 for visual grouping
            childIndent = indent + 1;
          } else {
            // Single-child chain: stay flat
            childIndent = indent;
          }

          // Build gutters for children
          // 虚拟根孩子不画普通分叉连接符；其余计算竖线应占的缩进位置。
          const connectorDisplayed = showConnector && !isVirtualRootChild;
          const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
          const connectorPosition = Math.max(0, currentDisplayIndent - 1);
          // 三元表达式只在需新竖线时生成新数组；show:!isLast表示后面还有兄弟需延续竖线。
          const childGutters = connectorDisplayed
            ? [...gutters, { position: connectorPosition, show: !isLast }]
            : gutters;

          // Add children in reverse order for stack
          for (let i = orderedChildren.length - 1; i >= 0; i--) {
            const childIsLast = i === orderedChildren.length - 1;
            // 新子项不是虚拟根孩子，是否连线/justBranched由本父节点是否多子决定。
            stack.push([orderedChildren[i], childIndent, multipleChildren, multipleChildren, childIsLast, childGutters, false]);
          }
        }

        return result;
      }

      /**
       * Build ASCII prefix string for tree node.
       */
      // 输入一条展平布局记录，返回缩进/竖线/拐角文字，不接触DOM；例如非末兄弟用├─、末兄弟用└─。
      // 每级占3个JS字符位置，使用Unicode画线而非严格ASCII，不计算终端或字体实际像素宽。
      function buildTreePrefix(flatNode) {
        const { indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots } = flatNode;
        // 对象解构取布局字段，多根时去掉虚拟根占位，避免顶层整体右移。
        const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
        const connector = showConnector && !isVirtualRootChild ? (isLast ? '└─ ' : '├─ ') : '';
        const connectorPosition = connector ? displayIndent - 1 : -1;

        // 前缀数组逐位置构造，connector字符串主要用于判断有无连线，实际字符在循环里逐个放入。
        const totalChars = displayIndent * 3;
        const prefixChars = [];
        for (let i = 0; i < totalChars; i++) {
          // 整除得缩进级，余数得该级的三格位置。
          const level = Math.floor(i / 3);
          const posInLevel = i % 3;

          // 优先绘制祖先延续竖线，其次当前├/└，其余补空格。
          const gutter = gutters.find(g => g.position === level);
          if (gutter) {
            prefixChars.push(posInLevel === 0 ? (gutter.show ? '│' : ' ') : ' ');
          } else if (connector && level === connectorPosition) {
            if (posInLevel === 0) {
              prefixChars.push(isLast ? '└' : '├');
            } else if (posInLevel === 1) {
              prefixChars.push('─');
            } else {
              prefixChars.push(' ');
            }
          } else {
            prefixChars.push(' ');
          }
        }
        // join无分隔符拼成最终前缀，交textContent展示，不把它当HTML。
        return prefixChars.join('');
      }

      // ============================================================
      // FILTERING (pure data)
      // ============================================================

      // 这两个可变状态只筛侧栏树；右侧聊天仍由当前叶子的完整父链生成，不因搜索关键词删消息。
      let filterMode = 'default';
      let searchQuery = '';

      // 输入字符串或内容块数组，返回是否有非空白text正文，无修改；例如只有thinking/toolCall/image会false。
      // trim只用于判断，不把原消息正文改写；JavaScript允许实际未知形状，函数只处理这里列出的分支。
      function hasTextContent(content) {
        if (typeof content === 'string') return content.trim().length > 0;
        if (Array.isArray(content)) {
          // 找到首块非空文字立即true，其他块不参与“有正文”的判断。
          for (const c of content) {
            if (c.type === 'text' && c.text && c.text.trim().length > 0) return true;
          }
        }
        return false;
      }

      // 输入消息正文，字符串原样返回，数组只取真值text块后无分隔拼接，其他输入空串；供侧栏摘要/搜索。
      // 例如[text A,image,text B]得到AB，和后面系统/聊天渲染用LF连接的规则不同，不解码图片。
      function extractContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          // filter挑块、map取文字、join('')拼成新串，不修改输入数组。
          return content
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text)
            .join('');
        }
        return '';
      }

      // ============================================================
      // SYSTEM MESSAGES (pure data)
      // ============================================================

      // 输入系统消息正文，取文字并用LF连接，其他形状空串；例如两text块A/B得到A换行B，无DOM副作用。
      function systemContentText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content.filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n');
        }
        return '';
      }

      /** Full prompt text of a system message, mirroring getSystemMessageText() in pi-ai. */
      // 输入单条system消息，把本条content和非null章节拼成完整文字，无历史重放；例：正文A加rules=B，用空行分隔。
      // 镜像pi-ai helper的有效数据行为，不校验任意sections值类型；null是删除标记，空字符串段不输出。
      function getSystemMessageText(msg) {
        const parts = [systemContentText(msg.content)];
        // Object.values只看自有可枚举章节，保持JS对象枚举顺序；||允许缺省对象。
        for (const value of Object.values(msg.sections || {})) {
          if (value !== null) parts.push(value);
        }
        // 不加入空段，但不会trim有内容的段落首尾空白。
        return parts.filter(part => part.length > 0).join('\n\n');
      }

      /** Text of a later system message, mirroring renderSystemMessageUpdate() in pi-ai. */
      // 输入后续system消息，返回正文和逐章节更新/删除说明，保持与pi-ai展示语句一致，不修改msg或累积当前完整prompt。
      // 例如sections.rules=null生成删除说明，rules=''仍生成更新；工具增删不在返回文字里，另由renderEntry渲染。
      function renderSystemMessageUpdate(msg) {
        const parts = [];
        const text = systemContentText(msg.content);
        if (text.length > 0) parts.push(text);
        // Object.entries同时取章节名和值，解构后用null精确区分删除与更新。
        for (const [name, value] of Object.entries(msg.sections || {})) {
          parts.push(value === null
            ? `Removed system prompt section "${name}".`
            : `Updated system prompt section "${name}":\n\n${value}`);
        }
        return parts.join('\n\n');
      }

      // 输入条目，判断是否携带system状态，供判断后续更新；system消息为true，compaction有systemMessage时返回该真值对象。
      // 此JS函数不保证严格boolean，因为&&/||返回操作数；例如compaction无systemMessage可undefined，不做投影合并。
      function carriesSystemState(entry) {
        return (entry.type === 'message' && entry.message.role === 'system') ||
          (entry.type === 'compaction' && entry.systemMessage);
      }

      /**
       * Whether a system entry starts the prompt on its branch. Later system entries
       * patch the prompt, so they render as updates instead of a full prompt.
       */
      // 输入待展示的system条目，沿父链找更早system消息或压缩system快照；没有则true，发现则false，无DOM操作。
      // 例如压缩后第一条system补丁仍是更新，不误称新初始prompt；缺父/自环会停止，其他父链环未通用防护。
      function isLeadingSystemEntry(entry) {
        let current = entry.parentId && entry.parentId !== entry.id ? byId.get(entry.parentId) : undefined;
        while (current) {
          if (carriesSystemState(current)) return false;
          if (!current.parentId || current.parentId === current.id) break;
          current = byId.get(current.parentId);
        }
        return true;
      }

      /** Short description of what a later system message changes, e.g. "project_context, -rules, tools +bash". */
      // 输入system补丁，返回简短变化列表，无修改；例如正文、rules删除、加bash工具得到instructions, -rules, tools +bash。
      // 仅作标题/搜索提示，不执行工具增删；空变化返回空串。
      function describeSystemUpdate(msg) {
        const parts = [];
        if (systemContentText(msg.content).length > 0) parts.push('instructions');
        for (const [name, value] of Object.entries(msg.sections || {})) {
          parts.push(value === null ? `-${name}` : name);
        }
        // ...展开两个map结果，把新增前加+、移除前加-后合到新数组。
        const toolChanges = [
          ...(msg.toolsAdded || []).map(t => `+${t.name}`),
          ...(msg.toolsRemoved || []).map(t => `-${t.name}`),
        ];
        if (toolChanges.length > 0) parts.push(`tools ${toolChanges.join(' ')}`);
        return parts.join(', ');
      }

      // 全历史只要有system消息就不在页头回退显示导出时当前prompt；只含compaction快照并不使此标记为true。
      const hasSystemEntries = entries.some(entry => entry.type === 'message' && entry.message.role === 'system');

      /**
       * Parse a skill block from message text.
       * Returns null if the text doesn't contain a skill block.
       * Matches the format: <skill name="..." location="...">\n...\n</skill>\n\nuser message
       */
      // 输入整段用户文字，按固定skill包装格式解析，返回名字/位置/正文/可选用户追加文字，匹配失败null，无I/O。
      // 例如<skill ...>后接LF正文、LF闭标签，再空行问题，可拆成两块展示；只认识双引号属性和LF布局，不是XML解析器，不读取location文件。
      function parseSkillBlock(text) {
        // ^/$整串匹配，[\s\S]*?跨换行尽早找闭标签，(?:...)不捕获，可选链读取可缺的第四组。
        const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
        if (!match) return null;
        return {
          name: match[1],
          location: match[2],
          content: match[3],
          userMessage: match[4]?.trim() || undefined,
        };
      }

      // 输入条目与标签，收集该类型的搜索文字并转小写返回，无DOM；例如model_change可按model及模型名查找。
      // 不把图片、thinking或所有工具参数都纳入搜索；compaction只加分类词，branch_summary才加摘要正文，最后用空格分隔各片段。
      function getSearchableText(entry, label) {
        const parts = [];
        if (label) parts.push(label);

        // switch按条目type分流，message内部再按role；break只结束switch，不退出整个函数。
        switch (entry.type) {
          case 'message': {
            const msg = entry.message;
            parts.push(msg.role);
            // 系统条目还加prompt/update分类、章节名和工具名，便于按配置变化找节点。
            if (msg.role === 'system') {
              parts.push(isLeadingSystemEntry(entry) ? 'system prompt' : 'system update');
              parts.push(getSystemMessageText(msg));
              for (const name of Object.keys(msg.sections || {})) parts.push(name);
              for (const tool of [...(msg.toolsAdded || []), ...(msg.toolsRemoved || [])]) parts.push(tool.name);
              break;
            }
            if (msg.content) parts.push(extractContent(msg.content));
            if (msg.role === 'bashExecution' && msg.command) parts.push(msg.command);
            break;
          }
          case 'custom_message':
            parts.push(entry.customType);
            parts.push(typeof entry.content === 'string' ? entry.content : extractContent(entry.content));
            break;
          case 'compaction':
            parts.push('compaction');
            break;
          case 'branch_summary':
            parts.push('branch summary', entry.summary);
            break;
          case 'model_change':
            parts.push('model', entry.modelId);
            break;
          case 'thinking_level_change':
            parts.push('thinking', entry.thinkingLevel);
            break;
          case 'context_edit':
            parts.push('context edit', entry.replacement === null ? 'omit' : 'replace', entry.targetId);
            break;
        }

        return parts.join(' ').toLowerCase();
      }

      /**
       * Filter flat nodes based on current filterMode and searchQuery.
       */
      // 输入全树展平记录及当前叶id，按页面筛选/搜索返回新数组，再原地更新这些展示记录的连线信息；不删除历史条目。
      // 当前叶总保留，即便不匹配搜索；无正文的普通助手工具调用节点先隐藏，因此all模式也不保证显示每条记录。
      // 例如搜索多个空白分隔词，需全部出现在同一节点搜索文字中，不查整个分支是否共同满足；搜索只影响侧栏。
      function filterNodes(flatNodes, currentLeafId) {
        // 转小写、按一或多个空白切词，filter(Boolean)去空词。
        const searchTokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

        const filtered = flatNodes.filter(flatNode => {
          const entry = flatNode.node.entry;
          const label = flatNode.node.label;
          // 标签来自包装节点，当前叶例外优先级高于后面所有筛选条件。
          const isCurrentLeaf = entry.id === currentLeafId;

          // Always show current leaf
          if (isCurrentLeaf) return true;

          // Hide assistant messages with only tool calls (no text) unless error/aborted
          if (entry.type === 'message' && entry.message.role === 'assistant') {
            const msg = entry.message;
            const hasText = hasTextContent(msg.content);
            // 非stop/toolUse的真值停止原因按异常保留，不只严格枚举error/aborted两种。
            const isErrorOrAborted = msg.stopReason && msg.stopReason !== 'stop' && msg.stopReason !== 'toolUse';
            if (!hasText && !isErrorOrAborted) return false;
          }

          // Apply filter mode
          // 设置类条目默认隐藏；custom_message与custom不同，前者不在这份设置表里。
          const isSettingsEntry = ['label', 'custom', 'context_edit', 'model_change', 'thinking_level_change'].includes(entry.type);
          let passesFilter = true;

          // user-only只用户；no-tools再排设置/工具结果；labeled-only看label是否非undefined；all放行此前尚未被隐藏的节点。
          switch (filterMode) {
            case 'user-only':
              passesFilter = entry.type === 'message' && entry.message.role === 'user';
              break;
            case 'no-tools':
              passesFilter = !isSettingsEntry && !(entry.type === 'message' && entry.message.role === 'toolResult');
              break;
            case 'labeled-only':
              passesFilter = label !== undefined;
              break;
            case 'all':
              passesFilter = true;
              break;
            default: // 'default'
              passesFilter = !isSettingsEntry;
              break;
          }

          if (!passesFilter) return false;

          // Apply search filter
          if (searchTokens.length > 0) {
            const nodeText = getSearchableText(entry, label);
            // every是“全部词”而非任一词，includes是子串匹配，不是正则/模糊搜索。
            if (!searchTokens.every(t => nodeText.includes(t))) return false;
          }

          return true;
        });

        // Recalculate visual structure based on visible tree
        // filtered与flatNodes共享同一包装记录，重算会改这些记录的缩进等字段，不改entry的parentId。
        recalculateVisualStructure(filtered, flatNodes);

        return filtered;
      }

      /**
       * Recompute indentation/connectors for the filtered view
       *
       * Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
       * Keep indentation semantics aligned with flattenTree() so single-child chains don't drift right.
       */
      // 输入可见节点与全展平表，原地重算可见布局，无返回/DOM操作；隐藏中间节点时让后代挂最近可见祖先。
      // 例如A→B→C隐藏B，布局上C接A，但会话原父链仍是B；用显式栈支持深链，查祖先仍可能多次回溯，不保证线性复杂度或任意环可结束。
      function recalculateVisualStructure(filteredNodes, allFlatNodes) {
        if (filteredNodes.length === 0) return;

        // Set用于快速判断“这个祖先是否还可见”，Map同时保留全树的真实父id。
        const visibleIds = new Set(filteredNodes.map(n => n.node.entry.id));

        // Build entry map for parent lookup (using full tree)
        const entryMap = new Map();
        for (const flatNode of allFlatNodes) {
          entryMap.set(flatNode.node.entry.id, flatNode);
        }

        // Find nearest visible ancestor for a node
        // 输入id，向父链找最近可见id，缺失到根返回null；不修改链，未检测多节点循环。
        function findVisibleAncestor(nodeId) {
          let currentId = entryMap.get(nodeId)?.node.entry.parentId;
          while (currentId != null) {
            if (visibleIds.has(currentId)) {
              return currentId;
            }
            currentId = entryMap.get(currentId)?.node.entry.parentId;
          }
          return null;
        }

        // Build visible tree structure
        // 两份Map记录可见父/孩子，null作虚拟根键；visibleParent在当前实现只记录，没有后续读取。
        const visibleParent = new Map();
        const visibleChildren = new Map();
        visibleChildren.set(null, []); // root-level nodes

        for (const flatNode of filteredNodes) {
          const nodeId = flatNode.node.entry.id;
          // 可见孩子按filtered原顺序追加，所以保留前面活跃分支优先的相对顺序。
          const ancestorId = findVisibleAncestor(nodeId);
          visibleParent.set(nodeId, ancestorId);

          if (!visibleChildren.has(ancestorId)) {
            visibleChildren.set(ancestorId, []);
          }
          visibleChildren.get(ancestorId).push(nodeId);
        }

        // Update multipleRoots based on visible roots
        const visibleRootIds = visibleChildren.get(null);
        // 过滤后根数可能不同于全树，重新决定是否占用虚拟根缩进。
        const multipleRoots = visibleRootIds.length > 1;

        // Build a map for quick lookup: nodeId → FlatNode
        const filteredNodeMap = new Map();
        for (const flatNode of filteredNodes) {
          filteredNodeMap.set(flatNode.node.entry.id, flatNode);
        }

        // DFS traversal of visible tree, applying same indentation rules as flattenTree()
        // Stack items: [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
        const stack = [];

        // Add visible roots in reverse order (to process in forward order via stack)
        for (let i = visibleRootIds.length - 1; i >= 0; i--) {
          const isLast = i === visibleRootIds.length - 1;
          stack.push([
            visibleRootIds[i],
            multipleRoots ? 1 : 0,
            multipleRoots,
            multipleRoots,
            isLast,
            [],
            multipleRoots
          ]);
        }

        while (stack.length > 0) {
          const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();

          const flatNode = filteredNodeMap.get(nodeId);
          if (!flatNode) continue;

          // Update this node's visual properties
          // 改的是展示包装字段，不是会话条目的type/parentId/消息正文。
          flatNode.indent = indent;
          flatNode.showConnector = showConnector;
          flatNode.isLast = isLast;
          flatNode.gutters = gutters;
          flatNode.isVirtualRootChild = isVirtualRootChild;
          flatNode.multipleRoots = multipleRoots;

          // Get visible children of this node
          // 缺孩子用空数组；之后分叉/首代/单链三种缩进规则与flattenTree同义。
          const children = visibleChildren.get(nodeId) || [];
          const multipleChildren = children.length > 1;

          // Calculate child indent using same rules as flattenTree():
          // - Parent branches (multiple children): children get +1
          // - Just branched and indent > 0: children get +1 for visual grouping
          // - Single-child chain: stay flat
          let childIndent;
          if (multipleChildren) {
            childIndent = indent + 1;
          } else if (justBranched && indent > 0) {
            childIndent = indent + 1;
          } else {
            childIndent = indent;
          }

          // Build gutters for children (same logic as flattenTree)
          // 根据可见树决定祖先竖线是否延续，不沿用已隐藏兄弟造成的旧连线。
          const connectorDisplayed = showConnector && !isVirtualRootChild;
          const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
          const connectorPosition = Math.max(0, currentDisplayIndent - 1);
          const childGutters = connectorDisplayed
            ? [...gutters, { position: connectorPosition, show: !isLast }]
            : gutters;

          // Add children in reverse order (to process in forward order via stack)
          for (let i = children.length - 1; i >= 0; i--) {
            const childIsLast = i === children.length - 1;
            stack.push([
              children[i],
              childIndent,
              multipleChildren,
              multipleChildren,
              childIsLast,
              childGutters,
              false
            ]);
          }
        }
      }

      // ============================================================
      // TREE DISPLAY TEXT (pure data -> string)
      // ============================================================

      // 输入路径文字，显示时把/Users/用户名或/home/用户名部分缩成~，其他字符串原样，非字符串空串，无文件访问。
      // 例如/home/alice/a.ts→~/a.ts；没有确认这个用户名真是当前用户，不展开~或读取文件，不是通用Windows路径缩写。
      function shortenPath(p) {
        if (typeof p !== 'string') return '';
        if (p.startsWith('/Users/')) {
          // split的前导空段使用户名位于parts[2]，slice去掉对应前缀长度。
          const parts = p.split('/');
          if (parts.length > 2) return '~' + p.slice(('/Users/' + parts[2]).length);
        }
        if (p.startsWith('/home/')) {
          const parts = p.split('/');
          if (parts.length > 2) return '~' + p.slice(('/home/' + parts[2]).length);
        }
        return p;
      }

      // 输入工具名/参数，返回侧栏用的简短文字，不执行工具、不返回已转义HTML；上层getTreeNodeDisplayHtml负责escapeHtml。
      // read/write/edit取路径，bash折叠换行/tab并最多取50码元，grep/find/ls给各自摘要，其余JSON取40码元；坏参数/不可序列化值仍可抛。
      function formatToolCall(name, args) {
        switch (name) {
          case 'read': {
            // 侧栏这里path真值优先file_path，和正文renderToolCall使用??且file_path优先的规则不同。
            const path = shortenPath(String(args.path || args.file_path || ''));
            return `[read: ${path}${formatReadLineRange(args.offset, args.limit)}]`;
          }
          case 'write':
            return `[write: ${shortenPath(String(args.path || args.file_path || ''))}]`;
          case 'edit':
            return `[edit: ${shortenPath(String(args.path || args.file_path || ''))}]`;
          case 'bash': {
            const rawCmd = String(args.command || '');
            // 清理后截码元，...判断却看原rawCmd长度，不能当完整shell转义/命令解析。
            const cmd = rawCmd.replace(/[\n\t]/g, ' ').trim().slice(0, 50);
            return `[bash: ${cmd}${rawCmd.length > 50 ? '...' : ''}]`;
          }
          case 'grep':
            return `[grep: /${args.pattern || ''}/ in ${shortenPath(String(args.path || '.'))}]`;
          case 'find':
            return `[find: ${args.pattern || ''} in ${shortenPath(String(args.path || '.'))}]`;
          case 'ls':
            return `[ls: ${shortenPath(String(args.path || '.'))}]`;
          default: {
            // JSON.stringify在此会再调用一次计算总长度，循环引用等错误未catch。
            const argsStr = JSON.stringify(args).slice(0, 40);
            return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? '...' : ''}]`;
          }
        }
      }

      // 输入值，先String再转义HTML特殊字符，返回可嵌正文/带引号属性的文字，无DOM；例如<b>显示为字面标签。
      // 先处理&避免本次生成实体被重复转义，不代表URL协议已允许，也不移除所有控制字符；自定义String转换仍可抛。
      function escapeHtml(text) {
        return String(text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      // 输入Markdown URL值，trim并去C0/DEL控制字符后检查scheme，允许http/https/mailto/tel/ftp，其他显式scheme返回null。
      // 例如java加控制字符再接script:也被清理后拒绝；相对地址/#锚点/协议相对URL没有显式scheme会保留，不判断站点可信或阻止远端图片联网。
      function sanitizeMarkdownUrl(value) {
        const href = String(value || '').trim().replace(/[\x00-\x1f\x7f]/g, '');
        if (!href) return href;

        // 只在开头解析scheme，白名单正则带i忽略协议大小写；不是浏览器URL的完整规范化器。
        const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
        if (scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1])) {
          return null;
        }

        return href;
      }

      /**
       * Truncate string to maxLen chars, append "..." if truncated.
       */
      // 输入字符串/可选码元预算，没超原样返回，超长保留前maxLen码元再加...，无I/O。
      // 例如abcdef、3得到abc...，后缀不计预算，也不保证不拆emoji代理对/可见字形簇。
      function truncate(s, maxLen = 100) {
        if (s.length <= maxLen) return s;
        return s.slice(0, maxLen) + '...';
      }

      /**
       * Get display text for tree node (returns HTML string).
       */
      // 输入条目与可选标签，返回侧栏的一行HTML，不操作DOM；按消息/状态类型抽短摘要，并对动态文字作HTML转义。
      // 用户skill包装优先显示技能名及追加问题，助手优先文字再aborted/错误/无正文，工具结果可用全局调用索引找原参数。
      // 压缩只显示tokensBefore约千数，不在这里生成新摘要；该函数的折短/搜索取文规则不等于右侧完整聊天渲染。
      function getTreeNodeDisplayHtml(entry, label) {
        // 局部normalize只把LF/tab变空格再trim；labelHtml是已转义标签，后面每类前面复用。
        const normalize = s => s.replace(/[\n\t]/g, ' ').trim();
        const labelHtml = label ? `<span class="tree-label">[${escapeHtml(label)}]</span> ` : '';

        switch (entry.type) {
          case 'message': {
            const msg = entry.message;
            if (msg.role === 'user') {
              const rawContent = extractContent(msg.content);
              // 侧栏extractContent无分隔拼接文字后再解析skill，正文renderEntry则以LF连接，存在不同布局规则。
              const skillBlock = parseSkillBlock(rawContent);
              if (skillBlock) {
                let treeHtml = labelHtml + `<span class="tree-role-skill">skill:</span> ${escapeHtml(skillBlock.name)}`;
                if (skillBlock.userMessage) {
                  treeHtml += ` · <span class="tree-role-user">user:</span> ${escapeHtml(truncate(normalize(skillBlock.userMessage)))}`;
                }
                return treeHtml;
              }
              const content = truncate(normalize(rawContent));
              return labelHtml + `<span class="tree-role-user">user:</span> ${escapeHtml(content)}`;
            }
            if (msg.role === 'assistant') {
              const textContent = truncate(normalize(extractContent(msg.content)));
              // 助手有文字则优先显示文字，即使同时带错误/aborted，也不会走后面状态摘要。
              if (textContent) {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> ${escapeHtml(textContent)}`;
              }
              if (msg.stopReason === 'aborted') {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(aborted)</span>`;
              }
              if (msg.errorMessage) {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-error">${escapeHtml(truncate(msg.errorMessage))}</span>`;
              }
              return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(no text)</span>`;
            }
            if (msg.role === 'toolResult') {
              // id在全历史Map反查，缺调用才退到toolName，不重发工具请求。
              const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : null;
              if (toolCall) {
                return labelHtml + `<span class="tree-role-tool">${escapeHtml(formatToolCall(toolCall.name, toolCall.arguments))}</span>`;
              }
              return labelHtml + `<span class="tree-role-tool">[${escapeHtml(msg.toolName || 'tool')}]</span>`;
            }
            if (msg.role === 'bashExecution') {
              const cmd = truncate(normalize(msg.command || ''));
              return labelHtml + `<span class="tree-role-tool">[bash]:</span> ${escapeHtml(cmd)}`;
            }
            if (msg.role === 'system') {
              if (isLeadingSystemEntry(entry)) {
                return labelHtml + `<span class="tree-muted">[system prompt]</span>`;
              }
              const changes = describeSystemUpdate(msg);
              return labelHtml + `<span class="tree-muted">[system update${changes ? ': ' + escapeHtml(truncate(changes)) : ''}]</span>`;
            }
            return labelHtml + `<span class="tree-muted">[${escapeHtml(msg.role)}]</span>`;
          }
          case 'compaction':
            return labelHtml + `<span class="tree-compaction">[compaction: ${Math.round(entry.tokensBefore/1000)}k tokens]</span>`;
          case 'branch_summary': {
            const summary = truncate(normalize(entry.summary || ''));
            return labelHtml + `<span class="tree-branch-summary">[branch summary]:</span> ${escapeHtml(summary)}`;
          }
          case 'custom_message': {
            const content = typeof entry.content === 'string' ? entry.content : extractContent(entry.content);
            return labelHtml + `<span class="tree-custom">[${escapeHtml(entry.customType)}]:</span> ${escapeHtml(truncate(normalize(content)))}`;
          }
          case 'model_change':
            return labelHtml + `<span class="tree-muted">[model: ${escapeHtml(entry.modelId)}]</span>`;
          case 'thinking_level_change':
            return labelHtml + `<span class="tree-muted">[thinking: ${escapeHtml(entry.thinkingLevel)}]</span>`;
          case 'context_edit':
            return labelHtml + `<span class="tree-muted">[context ${entry.replacement === null ? 'omit' : 'replace'}: ${escapeHtml(entry.targetId)}]</span>`;
          default:
            return labelHtml + `<span class="tree-muted">[${escapeHtml(entry.type)}]</span>`;
        }
      }

      // ============================================================
      // TREE RENDERING (DOM manipulation)
      // ============================================================

      // 当前叶决定右侧整条路径，当前目标仅决定选中/滚动位置，两者可不同；treeRendered记录侧栏DOM是否已整体建立。
      let currentLeafId = leafId;
      let currentTargetId = urlTargetId || leafId;
      let treeRendered = false;

      // 无输入，依当前叶/目标/筛选构造布局并更新侧栏DOM和计数，返回undefined；首次或force标记时完整重建，否则只更新选中标记。
      // 例如点击另一分支后普通重绘不会重排已有DOM/重新应用新可见列表，虽然会重算filtered并更新数量；不要称每次都会全量同步树结构。
      // 末尾setTimeout安排布局后滚动到active项，不保证严格在某个浏览器绘制帧执行，无网络/模型调用。
      function renderTree() {
        // 顺序取得新树、活跃路径、展平表、筛选列表，数据阶段与后面的DOM阶段分开。
        const tree = buildTree();
        const activePathIds = buildActivePathIds(currentLeafId);
        const flatNodes = flattenTree(tree, activePathIds);
        const filtered = filterNodes(flatNodes, currentLeafId);
        const container = document.getElementById('tree-container');

        // Full render only on first call or when filter/search changes
        if (!treeRendered) {
          // 直接清空容器会移除旧节点和其监听，再按本次filtered生成新行。
          container.innerHTML = '';

          for (const flatNode of filtered) {
            const entry = flatNode.node.entry;
            const isOnPath = activePathIds.has(entry.id);
            const isTarget = entry.id === currentTargetId;

            // createElement创建尚未挂载节点，classList表示当前路径/目标；dataset.id是字符串属性，不拼进HTML文本。
            const div = document.createElement('div');
            div.className = 'tree-node';
            if (isOnPath) div.classList.add('in-path');
            if (isTarget) div.classList.add('active');
            div.dataset.id = entry.id;

            const prefix = buildTreePrefix(flatNode);
            const prefixSpan = document.createElement('span');
            prefixSpan.className = 'tree-prefix';
            // 连线用textContent，浏览器不会把其中尖括号等当标签解析。
            prefixSpan.textContent = prefix;

            const marker = document.createElement('span');
            marker.className = 'tree-marker';
            marker.textContent = isOnPath ? '•' : ' ';

            const content = document.createElement('span');
            content.className = 'tree-content';
            // 只有内容摘要走HTML插入，依赖生成函数对动态字段转义；不是把原消息直接赋innerHTML。
            content.innerHTML = getTreeNodeDisplayHtml(entry, flatNode.node.label);

            div.appendChild(prefixSpan);
            div.appendChild(marker);
            div.appendChild(content);
            // Navigate to the newest leaf through this node, but scroll to the clicked node
            // 闭包捕获这条entry，选中文字时忽略点击；否则选其贪心叶并滚到当前点击节点。
            div.addEventListener('click', () => {
              if (window.getSelection().toString()) return;
              const leafId = findNewestLeaf(entry.id);
              navigateTo(leafId, 'target', entry.id);
            });

            container.appendChild(div);
          }

          // 标记以后可走轻更新；filter/search事件用forceTreeRerender显式清除此标记。
          treeRendered = true;
        } else {
          // Just update markers and classes
          // 只遍历已存在行，不增删/重排，也不重画连线和摘要。
          const nodes = container.querySelectorAll('.tree-node');
          for (const node of nodes) {
            const id = node.dataset.id;
            const isOnPath = activePathIds.has(id);
            const isTarget = id === currentTargetId;

            // toggle第二参数显式决定添加/移除，不是每次反转。
            node.classList.toggle('in-path', isOnPath);
            node.classList.toggle('active', isTarget);

            const marker = node.querySelector('.tree-marker');
            if (marker) {
              marker.textContent = isOnPath ? '•' : ' ';
            }
          }
        }

        // 数量按本次重算列表，可能与轻更新分支保留的旧DOM行数不同。
        document.getElementById('tree-status').textContent = `${filtered.length} / ${flatNodes.length} entries`;

        // Scroll active node into view after layout
        setTimeout(() => {
          const activeNode = container.querySelector('.tree-node.active');
          if (activeNode) {
            activeNode.scrollIntoView({ block: 'nearest' });
          }
        }, 0);
      }

      // 无输入/返回，先清完整渲染标志再立即renderTree；例如搜索/筛选变化需真正重建节点而非只改高亮。
      function forceTreeRerender() {
        treeRendered = false;
        renderTree();
      }

      // ============================================================
      // MESSAGE RENDERING
      // ============================================================

      // 输入计数，按量级返回原数/k/M展示文字，无副作用；例如1500→1.5k、10500→11k，四舍五入可能跨量级边界。
      // 假设有可用数字，不做有限/非负校验，不计算真实tokenizer数。
      function formatTokens(count) {
        if (count < 1000) return count.toString();
        if (count < 10000) return (count / 1000).toFixed(1) + 'k';
        if (count < 1000000) return Math.round(count / 1000) + 'k';
        return (count / 1000000).toFixed(1) + 'M';
      }

      // 输入时间值，假值空串，否则按浏览器本地时区/语言格式化时分秒；不改会话timestamp。
      // 例如同一UTC时间在不同查看者机器显示不同本地时间；无效日期交Date行为，不显式校验，数值0也被当缺失。
      function formatTimestamp(ts) {
        if (!ts) return '';
        const date = new Date(ts);
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      // 输入文字，将全部tab固定替成三个空格返回，不是按制表位/当前列对齐，无DOM修改；例如a\tb→a三个空格b。
      function replaceTabs(text) {
        return text.replace(/\t/g, '   ');
      }

      /** Safely coerce value to string for display. Returns null if invalid type. */
      // 展示参数的小边界：字符串原样，null/undefined空串，其他类型null表示无效；不把数字/对象强转成用户文字。
      // 例如args.command=123使正文显示invalid arg，而缺command显示占位...；原English的coerce不是泛化String转换。
      function str(value) {
        if (typeof value === 'string') return value;
        if (value == null) return '';
        return null;
      }

      // Mirrors ../tools/render-utils.ts.
      // 输入行号/数量，非空文字先Number转换，有限number返回，否则undefined；不要求整数/正数，无I/O。
      // 例如"1e2"得到100、" "失败、1.5仍接受，只服务展示，不验证read工具执行参数。
      function parseLineNumber(value) {
        if (typeof value === 'string' && value.trim() !== '') value = Number(value);
        return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      }

      // 输入可缺省起点/行数，返回:path风格的:起点-终点后缀，非法数字空串；不读取文件。
      // 例如offset缺省、limit=10→:1-10；无limit只:起点，end=0时原实现省略终点，不能把格式当严格行号校验器。
      function formatReadLineRange(offset, limit) {
        if (offset == null && limit == null) return '';
        const start = offset == null ? 1 : parseLineNumber(offset);
        if (start === undefined) return '';
        if (limit == null) return `:${start}`;
        const count = parseLineNumber(limit);
        if (count === undefined) return '';
        const end = start + count - 1;
        return `:${start}${end ? `-${end}` : ''}`;
      }

      // 输入文件路径文字，取最后一个点后小写片段，按固定表猜高亮语言或undefined；无文件读取，不识别shebang/文件真实内容。
      // 例如a.tsx→typescript，Dockerfile无点时整串小写也可命中；表是普通对象，继承键不作特殊隔离，后续高亮失败会走兜底。
      function getLanguageFromPath(filePath) {
        const ext = filePath.split('.').pop()?.toLowerCase();
        const extToLang = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
          c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
          php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
          sql: 'sql', html: 'html', css: 'css', scss: 'scss',
          json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
          md: 'markdown', dockerfile: 'dockerfile'
        };
        return extToLang[ext];
      }

      // 输入调用id，从全局entries正序找首条同id工具结果，返回原消息引用或null；不限制当前分支，也不执行工具。
      // 例如同id跨分支重复时首条胜出，与toolCallMap记录后条覆盖的行为不同；每次线性查找，没有结果索引缓存。
      function findToolResult(toolCallId) {
        for (const entry of entries) {
          if (entry.type === 'message' && entry.message.role === 'toolResult') {
            if (entry.message.toolCallId === toolCallId) {
              return entry.message;
            }
          }
        }
        return null;
      }

      // 输入文字、预览逻辑行数与可选语言，返回带折叠/展开HTML，不改DOM；先替tab，按LF切行，超出时同时嵌入完整/前缀两份文字。
      // 例如一行很长JSON仍只算一逻辑行，不像TUI按视觉换行截断；展开只是浏览器显示已嵌入内容，不读取临时全文文件。
      // 指定语言时高亮异常退转义文字，无语言不自动识别；返回HTML含点击切换事件，选中文字时不切换，不执行待展示代码。
      function formatExpandableOutput(text, maxLines, lang) {
        // split保留末尾空行，remaining可为负；后面只在>0时添加折叠提示。
        text = replaceTabs(text);
        const lines = text.split('\n');
        const displayLines = lines.slice(0, maxLines);
        const remaining = lines.length - maxLines;

        // 有语言先处理完整代码；预览需要时另高亮前maxLines行，不保证两次语法上下文颜色完全一致。
        if (lang) {
          let highlighted;
          try {
            // hljs返回已转义正文的span HTML，成功时不能再escape，否则标签会变可见文字。
            highlighted = hljs.highlight(text, { language: lang }).value;
          } catch {
            highlighted = escapeHtml(text);
          }

          // 以下多行模板是实际HTML内容，保留原文；完整/预览由CSS的expanded类切换。
          if (remaining > 0) {
            const previewCode = displayLines.join('\n');
            let previewHighlighted;
            try {
              previewHighlighted = hljs.highlight(previewCode, { language: lang }).value;
            } catch {
              previewHighlighted = escapeHtml(previewCode);
            }

            return `<div class="tool-output expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
              <div class="output-preview"><pre><code class="hljs">${previewHighlighted}</code></pre>
              <div class="expand-hint">... (${remaining} more lines)</div></div>
              <div class="output-full"><pre><code class="hljs">${highlighted}</code></pre></div></div>`;
          }

          return `<div class="tool-output"><pre><code class="hljs">${highlighted}</code></pre></div>`;
        }

        // 无语言时逐行转义并包div，保持原行内空白需配合CSS，而不是把文字当Markdown解析。
        // Plain text output
        if (remaining > 0) {
          let out = '<div class="tool-output expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle(\'expanded\')">';
          out += '<div class="output-preview">';
          for (const line of displayLines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
          }
          out += `<div class="expand-hint">... (${remaining} more lines)</div></div>`;
          out += '<div class="output-full">';
          for (const line of lines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
          }
          out += '</div></div>';
          return out;
        }

        let out = '<div class="tool-output">';
        for (const line of displayLines) {
          out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
        }
        out += '</div>';
        return out;
      }

      // 输入助手toolCall块，关联全历史首条结果，返回工具执行区HTML；不是执行请求，结果不存在显示pending。
      // 五个内建工具按各自参数展示，其余可用Node端预渲染片段或结构化兜底；正文/图片/嵌套调用各有展示规则。
      // 例如read显示图片和前10逻辑行，bash前5；错误仅影响状态类，历史数据不因展示改变。坏参数、序列化或生成HTML异常可传出。
      function renderToolCall(call) {
        // optional chaining使无结果时isError默认false，三元式区分pending/success/error。
        const result = findToolResult(call.id);
        const isError = result?.isError || false;
        const statusClass = result ? (isError ? 'error' : 'success') : 'pending';

        // 无输入闭包，取当前关联结果的text块以LF连接；没结果空串，不读图片、不重读磁盘全文。
        const getResultText = () => {
          if (!result) return '';
          const textBlocks = result.content.filter(c => c.type === 'text');
          return textBlocks.map(c => c.text).join('\n');
        };

        // 无输入闭包，筛出image块引用新数组；只提供给具体展示分支，不把所有二进制当图片。
        const getResultImages = () => {
          if (!result) return [];
          return result.content.filter(c => c.type === 'image');
        };

        // 无输入，返回data URL图片HTML或空串；对MIME/base64文字作属性转义，不验证图片内容，也不做尺寸/体积限制。
        const renderResultImages = () => {
          const images = getResultImages();
          if (images.length === 0) return '';
          return '<div class="tool-images">' +
            images.map(img => `<img src="data:${escapeHtml(img.mimeType || 'image/png')};base64,${escapeHtml(img.data || '')}" class="tool-image" />`).join('') +
            '</div>';
        };

        // Calls this tool made to other tools (for example from a codemode script), recorded without results.
        // 无输入，读取已记录nestedCalls生成摘要，返回可展开文字HTML；没有记录空串，不恢复嵌套工具结果或继续执行。
        const renderNestedCalls = () => {
          const nested = result?.nestedCalls;
          if (!nested || !Array.isArray(nested.calls) || nested.calls.length === 0) return '';
          const icons = { ok: '✓', error: '✗', unfinished: '…' };
          // 每个记录显示状态图标、参数/省略字节数、可选耗时和错误；图标不是重新验证工具成功。
          const lines = nested.calls.map(c => {
            // arguments按真值决定JSON或省略提示；记录限制不等于执行限制，complete=false只表示记录不全。
            const args = c.arguments ? JSON.stringify(c.arguments) : `[arguments omitted, ${c.argumentsBytes} bytes]`;
            const duration = c.durationMs !== undefined ? ` ${c.durationMs}ms` : '';
            const error = c.error ? `\n    ${c.error.split('\n').join('\n    ')}` : '';
            return `${icons[c.status] || '?'} ${c.name} ${args}${duration}${error}`;
          });
          const title = `Nested calls: ${nested.calls.length}${nested.complete ? '' : ' (incomplete record)'}`;
          return formatExpandableOutput([title, ...lines].join('\n'), 1);
        };

        // id转义用于HTML属性；最终DOM id会由浏览器解实体，后续getElementById需用原id而非再转义。
        const toolDomId = `tool-call-${escapeHtml(call.id)}`;
        let html = `<div class="tool-execution ${statusClass}" id="${toolDomId}">`;
        const args = call.arguments || {};
        const name = call.name;

        const invalidArg = '<span class="tool-error">[invalid arg]</span>';

        // 参数args回退{}，不同工具分支分别处理字符串边界；展示不会执行命令或写参数中的目标路径。
        switch (name) {
          case 'bash': {
            // null表示参数类型不对；空/缺命令用...，非空字符串先转义HTML。
            const command = str(args.command);
            const cmdDisplay = command === null ? invalidArg : escapeHtml(command || '...');
            html += `<div class="tool-command">$ ${cmdDisplay}</div>`;
            if (result) {
              const output = getResultText().trim();
              if (output) html += formatExpandableOutput(output, 5);
            }
            break;
          }
          case 'read': {
            // 正文file_path优先，??保留显式空串；不和侧栏path||file_path规则混为一谈。
            const filePath = str(args.file_path ?? args.path);
            const readLineRange = formatReadLineRange(args.offset, args.limit);
            let pathHtml = filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ''));
            if (filePath !== null && readLineRange) {
              pathHtml += `<span class="line-numbers">${escapeHtml(readLineRange)}</span>`;
            }

            html += `<div class="tool-header"><span class="tool-name">read</span> <span class="tool-path">${pathHtml}</span></div>`;
            if (result) {
              html += renderResultImages();
              const output = getResultText();
              // 仅根据路径后缀猜高亮，读取结果本身来自会话，不访问此路径。
              const lang = filePath ? getLanguageFromPath(filePath) : null;
              if (output) html += formatExpandableOutput(output, 10, lang);
            }
            break;
          }
          case 'write': {
            const filePath = str(args.file_path ?? args.path);
            // write展示当时参数内容；不是重新保存文件，空串不画代码正文。
            const content = str(args.content);

            html += `<div class="tool-header"><span class="tool-name">write</span> <span class="tool-path">${filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ''))}</span>`;
            if (content !== null && content) {
              const lines = content.split('\n');
              if (lines.length > 10) html += ` <span class="line-count">(${lines.length} lines)</span>`;
            }
            html += '</div>';

            if (content === null) {
              html += `<div class="tool-error">[invalid content arg - expected string]</div>`;
            } else if (content) {
              const lang = filePath ? getLanguageFromPath(filePath) : null;
              html += formatExpandableOutput(content, 10, lang);
            }
            if (result) {
              const output = getResultText().trim();
              if (output) html += `<div class="tool-output"><div>${escapeHtml(output)}</div></div>`;
            }
            break;
          }
          case 'edit': {
            const filePath = str(args.file_path ?? args.path);
            html += `<div class="tool-header"><span class="tool-name">edit</span> <span class="tool-path">${filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ''))}</span></div>`;

            // edit优先使用记录details.diff，每行+/-决定颜色；没有diff才显示结果文字，不重新计算文件差异。
            if (result?.details?.diff) {
              const diffLines = result.details.diff.split('\n');
              html += '<div class="tool-diff">';
              for (const line of diffLines) {
                const cls = line.match(/^\+/) ? 'diff-added' : line.match(/^-/) ? 'diff-removed' : 'diff-context';
                html += `<div class="${cls}">${escapeHtml(replaceTabs(line))}</div>`;
              }
              html += '</div>';
            } else if (result) {
              const output = getResultText().trim();
              if (output) html += `<div class="tool-output"><pre>${escapeHtml(output)}</pre></div>`;
            }
            break;
          }
          case 'ls': {
            const dirPath = str(args.path);
            // limit只转成展示文字，不在浏览器重新限制ls结果数量。
            const limit = args.limit;

            let pathHtml = dirPath === null ? invalidArg : escapeHtml(shortenPath(dirPath || '.'));
            if (limit !== undefined) {
              pathHtml += ` <span class="line-count">(limit ${escapeHtml(String(limit))})</span>`;
            }

            html += `<div class="tool-header"><span class="tool-name">ls</span> <span class="tool-path">${pathHtml}</span></div>`;
            if (result) {
              const output = getResultText().trim();
              if (output) html += formatExpandableOutput(output, 20);
            }
            break;
          }
          default: {
            // Check for pre-rendered custom tool HTML
            // 非五个模板内建工具才用预渲染片段；它们已是HTML，这里原样插入，依赖导出侧renderer的输出边界。
            const rendered = renderedTools?.[call.id];
            if (rendered?.callHtml || rendered?.resultHtmlCollapsed || rendered?.resultHtmlExpanded) {
              // Custom tool with pre-rendered HTML from TUI renderer
              if (rendered.callHtml) {
                html += `<div class="tool-header ansi-rendered">${rendered.callHtml}</div>`;
              } else {
                html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;
              }

              // 两种非空且不同时才做折叠；否则有expanded直接展示，无结果片段时再退当前text内容。
              if (rendered.resultHtmlCollapsed && rendered.resultHtmlExpanded && rendered.resultHtmlCollapsed !== rendered.resultHtmlExpanded) {
                // Both collapsed and expanded differ - render expandable section
                html += `<div class="tool-output expandable ansi-rendered" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
                  <div class="output-preview">${rendered.resultHtmlCollapsed}</div>
                  <div class="output-full">${rendered.resultHtmlExpanded}</div>
                </div>`;
              } else if (rendered.resultHtmlExpanded) {
                // Only expanded exists (or collapsed is identical) - show directly
                html += `<div class="tool-output ansi-rendered">${rendered.resultHtmlExpanded}</div>`;
              } else if (result) {
                // No pre-rendered result HTML - fallback to JSON
                const output = getResultText();
                if (output) html += formatExpandableOutput(output, 10);
              }
            } else {
              // Fallback to JSON display (existing behavior)
              html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;
              html += `<div class="tool-output"><pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre></div>`;
              if (result) {
                const output = getResultText();
                if (output) html += formatExpandableOutput(output, 10);
              }
            }
          }
        }

        // 最后统一附嵌套调用记录并闭工具外框，getResultImages并非对所有分支都调用。
        html += renderNestedCalls();
        html += '</div>';
        return html;
      }

      /**
       * Download the session data as a JSONL file.
       * Reconstructs the original format: header line + entry lines.
       */
      // 无输入，浏览器生成Blob并点击临时a下载内嵌全历史JSONL，无返回；按钮onclick调用此入口，页面初始化不调用，不向服务器上传。
      // 与core/session-export.ts只导当前分支不同，这里头+所有entries、不重连parentId、不补最终LF；type:'header'在展开header之前，真实header.type可覆盖它。
      // Blob URL最后revoke，过程未用finally；异常时清理不保证完成，下载文件名采用header.id或session，不加密/脱敏。
      window.downloadSessionJson = function() {
        // Build JSONL content: header first, then all entries
        // lines保存逐条JSON文字，不是只保存当前页面看见的消息/筛选节点。
        const lines = [];
        if (header) {
          lines.push(JSON.stringify({ type: 'header', ...header }));
        }
        for (const entry of entries) {
          lines.push(JSON.stringify(entry));
        }
        // join只在条目之间加LF，与核心JSONL导出固定尾换行的行为不同。
        const jsonlContent = lines.join('\n');

        // Create download
        // Blob把字符串按UTF8存成浏览器内存文件，MIME是下载提示，不验证每条JSON结构。
        const blob = new Blob([jsonlContent], { type: 'application/x-ndjson' });
        // createObjectURL得到当前浏览器对象URL，不是公网分享地址。
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${header?.id || 'session'}.jsonl`;
        // 临时挂载/触发点击/移除节点，下载是否被浏览器允许由浏览器策略决定。
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      /**
       * Build a shareable URL for a specific message.
       * URL format: base?gistId&leafId=<leafId>&targetId=<entryId>
       */
      // 输入条目id，返回指向当前叶和该目标的URL，不上传会话、不写剪贴板；例如复制链接后其他查看者可跳同一条目。
      // iframe可用注入base meta，直接访问则沿当前URL寻找首个空值查询键当gist id；不能把该启发式等同完整分享服务URL解析。
      function buildShareUrl(entryId) {
        // Check for injected base URL (used when loaded in iframe via srcdoc)
        const baseUrlMeta = document.querySelector('meta[name="pi-share-base-url"]');
        // 注入base分支会直接以&追加参数，依赖宿主预先给合适基址；非meta分支最终使用下面url对象。
        const baseUrl = baseUrlMeta ? baseUrlMeta.content : window.location.href.split('?')[0];

        const url = new URL(window.location.href);
        // Find the gist ID (first query param without value, e.g., ?abc123)
        // URLSearchParams.keys转数组后find第一个空值键；不是验证该键确实是合法gist id。
        const gistId = Array.from(url.searchParams.keys()).find(k => !url.searchParams.get(k));

        // Build the share URL
        const params = new URLSearchParams();
        // set将值转成查询参数编码，保留currentLeafId与目标entryId两种不同导航含义。
        params.set('leafId', currentLeafId);
        params.set('targetId', entryId);

        // If we have an injected base URL (iframe context), use it directly
        if (baseUrlMeta) {
          return `${baseUrl}&${params.toString()}`;
        }

        // Otherwise build from current location (direct file access)
        // 重建search会舍弃其他原查询参数，url对象的hash等其余部分仍按URL行为保留。
        url.search = gistId ? `?${gistId}&${params.toString()}` : `?${params.toString()}`;
        return url.toString();
      }

      /**
       * Copy text to clipboard with visual feedback.
       * Uses navigator.clipboard with fallback to execCommand for HTTP contexts.
       */
      // 输入待复制文字及可选反馈按钮，先浏览器Clipboard API，再临时textarea+execCommand回退；Promise无数据，实际写用户剪贴板。
      // 例如复制消息链接成功临时显示勾号1.5秒；失败进入回退/记录错误，代码未另开授权界面，API能否使用仍取决于浏览器权限/用户激活策略。
      // 不把成功反馈当跨设备确认；函数没有通用finally清textarea，回退中途异常可能留下节点。
      async function copyToClipboard(text, button) {
        let success = false;
        try {
          // 是否可用受安全上下文/权限/浏览器策略影响，存在API不等于调用必成功。
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            success = true;
          }
        } catch (err) {
          // Clipboard API failed, try fallback
        }

        // Fallback for HTTP or when Clipboard API is unavailable
        if (!success) {
          try {
            // 不可见textarea承载文字，select后让旧式copy命令复制，返回布尔表示该命令报告的成功。
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            success = document.execCommand('copy');
            document.body.removeChild(textarea);
          } catch (err) {
            console.error('Failed to copy:', err);
          }
        }

        // 只在成功且有按钮时反馈；保存原HTML供定时恢复，多次快速点击未做独立计时器协调。
        if (success && button) {
          const originalHtml = button.innerHTML;
          button.innerHTML = '✓';
          button.classList.add('copied');
          setTimeout(() => {
            button.innerHTML = originalHtml;
            button.classList.remove('copied');
          }, 1500);
        }
      }

      /**
       * Render the copy-link button HTML for a message.
       */
      // 输入条目id，返回含内嵌SVG图标的按钮HTML，无DOM/I/O；id先转义放data属性，事件稍后由navigateTo绑定。
      // 多行模板里的SVG/文案就是实际导出内容，保持原样，不在字符串中插入解释注释。
      function renderCopyLinkButton(entryId) {
        return `<button class="copy-link-btn" data-entry-id="${escapeHtml(entryId)}" title="Copy link to this message">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
        </button>`;
      }

      // 输入一条历史记录，返回正文区HTML或空串，无DOM；按消息role/条目type展示，不执行历史命令、不应用模型上下文投影。
      // 例如助手先文字/思考再工具调用，toolResult自身不单独画，而附在对应调用里；custom_message即便display:false也生成节点由CSS隐藏。
      // 压缩/分支摘要仅展示已存文本，不调用模型重算；model_change显示，其他未实现条目空串，数据不符合预期时错误可向上传播。
      function renderEntry(entry) {
        // timestamp按查看者本地时间展示，entryDomId与复制按钮的动态id均先转义HTML。
        const ts = formatTimestamp(entry.timestamp);
        const tsHtml = ts ? `<div class="message-timestamp">${ts}</div>` : '';
        const entryDomId = `entry-${escapeHtml(entry.id)}`;
        const copyBtnHtml = renderCopyLinkButton(entry.id);

        if (entry.type === 'message') {
          const msg = entry.message;

          if (msg.role === 'user') {
            const content = msg.content;
            // 用户字符串原样，数组取text以LF连接；图片稍后独立展示，不把图像base64串进Markdown。
            const text = typeof content === 'string' ? content :
              content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            const skillBlock = parseSkillBlock(text);

            // skill包装满足固定格式时拆技能正文和追加用户内容，location仅解析未作为本地文件读取。
            if (skillBlock) {
              // Collect images from content array
              const images = Array.isArray(content) ? content.filter(c => c.type === 'image') : [];
              // ||可返回实际用户字符串或布尔，这里只用于if真值，不保证严格boolean类型。
              const hasUserContent = skillBlock.userMessage || images.length > 0;
              let html = `<div class="skill-user-entry" id="${entryDomId}">${copyBtnHtml}${tsHtml}`;

              // Skill invocation (collapsed by default, click to expand)
              html += `<div class="skill-invocation" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
                <div class="skill-invocation-label">[skill] ${escapeHtml(skillBlock.name)}</div>
                <div class="skill-invocation-collapsed">${escapeHtml(skillBlock.name)} (click to expand)</div>
                <div class="skill-invocation-content markdown-content">${safeMarkedParse(skillBlock.content)}</div>
              </div>`;

              // 技能区先闭合后再加用户区，二者在skill-user-entry包装内为同级；模板正文原字节不动。
              // User message (separate block if present)
              if (hasUserContent) {
                html += '<div class="user-message">';
                if (images.length > 0) {
                  html += '<div class="message-images">';
                  for (const img of images) {
                    html += `<img src="data:${escapeHtml(img.mimeType || 'image/png')};base64,${escapeHtml(img.data || '')}" class="message-image" />`;
                  }
                  html += '</div>';
                }
                if (skillBlock.userMessage) {
                  html += `<div class="markdown-content">${safeMarkedParse(skillBlock.userMessage)}</div>`;
                }
                html += '</div>';
              }

              html += '</div>';
              return html;
            }

            // No skill block - normal user message
            let html = `<div class="user-message" id="${entryDomId}">${copyBtnHtml}${tsHtml}`;

            if (Array.isArray(content)) {
              const images = content.filter(c => c.type === 'image');
              if (images.length > 0) {
                html += '<div class="message-images">';
                for (const img of images) {
                  html += `<img src="data:${escapeHtml(img.mimeType || 'image/png')};base64,${escapeHtml(img.data || '')}" class="message-image" />`;
                }
                html += '</div>';
              }
            }

            // trim只判断是否显示，实际交Markdown的仍是原text，保留首尾内容。
            if (text.trim()) {
              html += `<div class="markdown-content">${safeMarkedParse(text)}</div>`;
            }
            html += '</div>';
            return html;
          }

          // 这一分支仅把历史内容生成HTML；先处理text/thinking，再第二遍处理toolCall，原块交错顺序不会完全保留。
          if (msg.role === 'assistant') {
            let html = `<div class="assistant-message" id="${entryDomId}">${copyBtnHtml}${tsHtml}`;

            // 思考用escapeHtml加pre-wrap式样而非Markdown；空白text/thinking不画正文块。
            for (const block of msg.content) {
              if (block.type === 'text' && block.text.trim()) {
                html += `<div class="assistant-text markdown-content">${safeMarkedParse(block.text)}</div>`;
              } else if (block.type === 'thinking' && block.thinking.trim()) {
                html += `<div class="thinking-block">
                  <div class="thinking-text">${escapeHtml(block.thinking)}</div>
                  <div class="thinking-collapsed">Thinking ...</div>
                </div>`;
              }
            }

            for (const block of msg.content) {
              if (block.type === 'toolCall') {
                html += renderToolCall(block);
              }
            }

            // 只有aborted/error两种停止原因在正文追加状态提示，错误消息先转义。
            if (msg.stopReason === 'aborted') {
              html += '<div class="error-text">Aborted</div>';
            } else if (msg.stopReason === 'error') {
              html += `<div class="error-text">Error: ${escapeHtml(msg.errorMessage || 'Unknown error')}</div>`;
            }

            html += '</div>';
            return html;
          }

          // 用户手动!命令的历史记录，区别于助手toolCall中的bash；这里只展示已存命令/输出/退出码。
          if (msg.role === 'bashExecution') {
            // cancelled或非0且非null退出码按错误着色，null本身不当非零错误，不再查询真实进程。
            const isError = msg.cancelled || (msg.exitCode !== 0 && msg.exitCode !== null);
            let html = `<div class="tool-execution ${isError ? 'error' : 'success'}" id="${entryDomId}">${tsHtml}`;
            html += `<div class="tool-command">$ ${escapeHtml(msg.command)}</div>`;
            if (msg.output) html += formatExpandableOutput(msg.output, 10);
            if (msg.cancelled) {
              html += '<div style="color: var(--warning)">(cancelled)</div>';
            } else if (msg.exitCode !== 0 && msg.exitCode !== null) {
              html += `<div style="color: var(--error)">(exit ${msg.exitCode})</div>`;
            }
            html += '</div>';
            return html;
          }

          // 结果由助手调用块关联显示，单独条目不生成entry节点；深链接稍后改指tool-call节点。
          if (msg.role === 'toolResult') return '';

          // 初始system画完整prompt/工具，后续画章节补丁/工具增删；判定沿本条父链，不凭全局第一条位置。
          if (msg.role === 'system') {
            let html = '';
            if (isLeadingSystemEntry(entry)) {
              const text = getSystemMessageText(msg);
              if (text) html += renderSystemPromptBlock('System Prompt', text);
              html += renderToolsList('Available Tools', msg.toolsAdded);
            } else {
              const text = renderSystemMessageUpdate(msg);
              // 更新摘要只构造标题，渲染函数自己转义title；removed工具列表只显示名称，不卸载浏览器代码。
              const changes = describeSystemUpdate(msg);
              if (text) html += renderSystemPromptBlock(`System Prompt Update${changes ? ': ' + changes : ''}`, text);
              html += renderToolsList('Tools Added', msg.toolsAdded);
              if (msg.toolsRemoved && msg.toolsRemoved.length > 0) {
                html += `<div class="tools-list"><div class="tools-header">Tools Removed</div><div class="tools-content">${msg.toolsRemoved.map(t => `<div class="tool-item"><span class="tool-item-name">${escapeHtml(t.name)}</span></div>`).join('')}</div></div>`;
              }
            }
            return html ? `<div class="system-entry" id="${entryDomId}">${tsHtml}${html}</div>` : '';
          }
        }

        // 状态条目同样仅展示，模型切换记录不会在浏览器配置任何API。
        if (entry.type === 'model_change') {
          return `<div class="model-change" id="${entryDomId}">${tsHtml}Switched to model: <span class="model-name">${escapeHtml(entry.provider)}/${escapeHtml(entry.modelId)}</span></div>`;
        }

        // 压缩卡片点击展开已存summary；tokensBefore是历史值，不重新估算当前页面的token。
        if (entry.type === 'compaction') {
          return `<div class="compaction" id="${entryDomId}" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
            <div class="compaction-label">[compaction]</div>
            <div class="compaction-collapsed">Compacted from ${entry.tokensBefore.toLocaleString()} tokens</div>
            <div class="compaction-content"><strong>Compacted from ${entry.tokensBefore.toLocaleString()} tokens</strong>\n\n${escapeHtml(entry.summary)}</div>
          </div>`;
        }

        // 分支摘要按Markdown展示，和压缩summary走纯转义文字不同。
        if (entry.type === 'branch_summary') {
          return `<div class="branch-summary" id="${entryDomId}">${tsHtml}
            <div class="branch-summary-header">Branch Summary</div>
            <div class="markdown-content">${safeMarkedParse(entry.summary)}</div>
          </div>`;
        }

        // 终端隐藏标记保存在CSS类中，内容仍在HTML/DOM/可下载数据里，不是隐私删除。
        if (entry.type === 'custom_message') {
          const hidden = entry.display === false;
          return `<div class="hook-message${hidden ? ' hook-message-hidden' : ''}" id="${entryDomId}">${tsHtml}
            <div class="hook-type">[${escapeHtml(entry.customType)}]${hidden ? ' · Hidden in terminal' : ''}</div>
            <div class="markdown-content">${safeMarkedParse(typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content))}</div>
          </div>`;
        }

        // 其他未实现的非消息条目不画独立正文，不表示已从entries或下载文件删去。
        return '';
      }

      // ============================================================
      // HEADER / STATS
      // ============================================================

      // 输入条目数组，汇总消息/工具调用/摘要数量、各项usage和已见模型，返回新统计对象，不修改历史、不查询账单。
      // 例如传全entries就跨全部分支累计，不只当前可见路径；成本优先已有数值cost.total，旧记录缺总额才按四分项相加。
      // ||0处理假值，未完整验证输入数字；typeof number也允许NaN等，不能把统计当供应商账单或严格JSON验证结果。
      function computeStats(entryList) {
        // 逗号声明同组计数变量，tokens/cost对象逐项累加，Set按首次见到的模型保留去重顺序。
        let userMessages = 0, assistantMessages = 0, toolResults = 0;
        let customMessages = 0, compactions = 0, branchSummaries = 0, toolCalls = 0;
        const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        const models = new Set();

        for (const entry of entryList) {
          if (entry.type === 'message') {
            const msg = entry.message;
            if (msg.role === 'user') userMessages++;
            if (msg.role === 'assistant') {
              assistantMessages++;
              // 有provider时加前缀，同名模型在不同provider下分开；缺provider只记model。
              if (msg.model) models.add(msg.provider ? `${msg.provider}/${msg.model}` : msg.model);
              if (msg.usage) {
                // 分别统计输入/输出/缓存读写，并非把这些数合成唯一上下文长度；不重新运行tokenizer。
                tokens.input += msg.usage.input || 0;
                tokens.output += msg.usage.output || 0;
                tokens.cacheRead += msg.usage.cacheRead || 0;
                tokens.cacheWrite += msg.usage.cacheWrite || 0;
                if (msg.usage.cost) {
                  // 分项和仅作旧记录后备，与已记录total可有差异，不能强制重算覆盖供应商总额。
                  const componentTotal =
                    (msg.usage.cost.input || 0) +
                    (msg.usage.cost.output || 0) +
                    (msg.usage.cost.cacheRead || 0) +
                    (msg.usage.cost.cacheWrite || 0);
                  cost.input += msg.usage.cost.input || 0;
                  cost.output += msg.usage.cost.output || 0;
                  cost.cacheRead += msg.usage.cost.cacheRead || 0;
                  cost.cacheWrite += msg.usage.cost.cacheWrite || 0;
                  // Provider-reported totals can intentionally differ from catalog-estimated components.
                  // Fall back to the component sum for sessions written before cost.total was recorded.
                  cost.total += typeof msg.usage.cost.total === 'number' ? msg.usage.cost.total : componentTotal;
                }
              }
              // 只数助手声明的工具调用块，不把nestedCalls内部执行逐项另算，调用数也不等于成功结果数。
              toolCalls += msg.content.filter(c => c.type === 'toolCall').length;
            }
            if (msg.role === 'toolResult') toolResults++;
          } else if (entry.type === 'compaction') {
            compactions++;
          } else if (entry.type === 'branch_summary') {
            branchSummaries++;
          } else if (entry.type === 'custom_message') {
            customMessages++;
          }
        }

        return { userMessages, assistantMessages, toolResults, customMessages, compactions, branchSummaries, toolCalls, tokens, cost, models: Array.from(models) };
      }

      // 页头统计一次固定为全历史，切换分支/搜索不会重算成当前路径统计。
      const globalStats = computeStats(entries);

      // 无输入，按全历史统计和当前全局展开状态返回页头HTML，不直接操作DOM；例如成本保留3位小数，0值项目部分不显示。
      // 模板中的日期/模型/计数/按钮均是实际网页文字；仅无任何system消息时附导出时当前systemPrompt/tools作旧会话回退。
      function renderHeader() {
        const totalCost = globalStats.cost.total;

        // ↑/↓/R/W分别展示已有usage分项，真值才加，不计算缓存命中率或账单折扣。
        const tokenParts = [];
        if (globalStats.tokens.input) tokenParts.push(`↑${formatTokens(globalStats.tokens.input)}`);
        if (globalStats.tokens.output) tokenParts.push(`↓${formatTokens(globalStats.tokens.output)}`);
        if (globalStats.tokens.cacheRead) tokenParts.push(`R${formatTokens(globalStats.tokens.cacheRead)}`);
        if (globalStats.tokens.cacheWrite) tokenParts.push(`W${formatTokens(globalStats.tokens.cacheWrite)}`);

        // 消息类型计数非零才加入概览；全为零后面展示0。
        const msgParts = [];
        if (globalStats.userMessages) msgParts.push(`${globalStats.userMessages} user`);
        if (globalStats.assistantMessages) msgParts.push(`${globalStats.assistantMessages} assistant`);
        if (globalStats.toolResults) msgParts.push(`${globalStats.toolResults} tool results`);
        if (globalStats.customMessages) msgParts.push(`${globalStats.customMessages} custom`);
        if (globalStats.compactions) msgParts.push(`${globalStats.compactions} compactions`);
        if (globalStats.branchSummaries) msgParts.push(`${globalStats.branchSummaries} branch summaries`);

        // 以下多行HTML保留原样，变量插值时各处按既有规则格式化/转义，不能在其正文插注释。
        let html = `
          <div class="header">
            <h1>Session: ${escapeHtml(header?.id || 'unknown')}</h1>
            <div class="help-bar">
              <span class="help-hint">T toggle thinking · O toggle tools · H toggle hidden messages</span>
              <div class="help-actions">
                <button type="button" class="header-toggle-btn" data-action="toggle-thinking" aria-pressed="${thinkingExpanded}" title="Toggle thinking (T)">Toggle thinking</button>
                <button type="button" class="header-toggle-btn" data-action="toggle-tools" aria-pressed="${toolOutputsExpanded}" title="Toggle tools (O)">Toggle tools</button>
                <button type="button" class="header-toggle-btn" data-action="toggle-hidden-messages" aria-pressed="${showHiddenMessages}" title="Show custom messages marked as hidden in the terminal (H).">${showHiddenMessages ? 'Hide hidden messages' : 'Show hidden messages'}</button>
                <button type="button" class="download-json-btn" onclick="downloadSessionJson()" title="Download session as JSONL">↓ JSONL</button>
              </div>
            </div>
            <div class="header-info">
              <div class="info-item"><span class="info-label">Date:</span><span class="info-value">${header?.timestamp ? new Date(header.timestamp).toLocaleString() : 'unknown'}</span></div>
              <div class="info-item"><span class="info-label">Models:</span><span class="info-value">${escapeHtml(globalStats.models.join(', ') || 'unknown')}</span></div>
              <div class="info-item"><span class="info-label">Messages:</span><span class="info-value">${msgParts.join(', ') || '0'}</span></div>
              <div class="info-item"><span class="info-label">Tool Calls:</span><span class="info-value">${globalStats.toolCalls}</span></div>
              <div class="info-item"><span class="info-label">Tokens:</span><span class="info-value">${tokenParts.join(' ') || '0'}</span></div>
              <div class="info-item"><span class="info-label">Cost:</span><span class="info-value">$${totalCost.toFixed(3)}</span></div>
            </div>
          </div>`;

        // Sessions with system entries render the prompt and tools in the transcript, where they
        // occur. Older sessions have none, so fall back to the exporting agent's current state.
        // 判断针对全历史，不因当前分支没有system消息而另补运行态prompt；纯文件导出可能没有回退state。
        if (!hasSystemEntries) {
          if (systemPrompt) html += renderSystemPromptBlock('System Prompt', systemPrompt);
          html += renderToolsList('Available Tools', tools);
        }

        return html;
      }

      // 输入标题/完整系统文字，返回纯转义展示卡片；超过10个LF逻辑行同时嵌入预览和全文供CSS切换，无模型请求。
      // 例如一条长行不会因视觉换行被折叠，尾换行会产生空逻辑行；短文本直接显示全文，不用Markdown解析提示词。
      function renderSystemPromptBlock(title, text) {
        const lines = text.split('\n');
        const previewLines = 10;
        if (lines.length > previewLines) {
          const preview = lines.slice(0, previewLines).join('\n');
          const remaining = lines.length - previewLines;
          return `<div class="system-prompt expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
            <div class="system-prompt-header">${escapeHtml(title)}</div>
            <div class="system-prompt-preview">${escapeHtml(preview)}</div>
            <div class="system-prompt-expand-hint">... (${remaining} more lines, click to expand)</div>
            <div class="system-prompt-full">${escapeHtml(text)}</div>
          </div>`;
        }
        return `<div class="system-prompt">
          <div class="system-prompt-header">${escapeHtml(title)}</div>
          <div class="system-prompt-full" style="display: block">${escapeHtml(text)}</div>
        </div>`;
      }

      // 输入标题和工具元数据列表，返回工具名称/描述及可点击参数列表HTML，空列表空串，无执行/校验工具参数。
      // 只读parameters.properties的第一层，required决定必填提示、prop.type缺省显示any；不完整展开嵌套/联合/引用schema。
      // 下方map回调位于外层模板插值中：它逐工具选择无参数简述或拼paramsHtml，再join；为保持模板字节，解释统一放在这里。
      // hasParams先检查parameters对象及非空properties；不满足时只显示转义后的name/description，不额外生成参数开关。
      // 有属性时取params/properties，required缺省[]；Object.entries逐个取字段名及prop，includes判断必填，prop.type真值优先否则any。
      // 每个参数先拼已转义名字/类型与固定required/optional标签，有description才再拼说明，最后闭合该参数div。
      // 每个工具返回带onclick的外框，点击切params-expanded类（有选区则不切）；paramsHtml放其详情区，空提示span由CSS生成视觉提示。
      // 最外层map得到工具HTML数组，join('')无分隔拼入tools-content；这些只是说明展示，不会执行schema里的默认值或工具函数。
      function renderToolsList(title, tools) {
        if (!tools || tools.length === 0) return '';
        return `<div class="tools-list">
            <div class="tools-header">${escapeHtml(title)}</div>
            <div class="tools-content">
              ${tools.map(t => {
                const hasParams = t.parameters && typeof t.parameters === 'object' && t.parameters.properties && Object.keys(t.parameters.properties).length > 0;
                if (!hasParams) {
                  return `<div class="tool-item"><span class="tool-item-name">${escapeHtml(t.name)}</span> - <span class="tool-item-desc">${escapeHtml(t.description)}</span></div>`;
                }
                const params = t.parameters;
                const properties = params.properties;
                const required = params.required || [];
                let paramsHtml = '';
                for (const [name, prop] of Object.entries(properties)) {
                  const isRequired = required.includes(name);
                  const typeStr = prop.type || 'any';
                  const reqLabel = isRequired ? '<span class="tool-param-required">required</span>' : '<span class="tool-param-optional">optional</span>';
                  paramsHtml += `<div class="tool-param"><span class="tool-param-name">${escapeHtml(name)}</span> <span class="tool-param-type">${escapeHtml(typeStr)}</span> ${reqLabel}`;
                  if (prop.description) {
                    paramsHtml += `<div class="tool-param-desc">${escapeHtml(prop.description)}</div>`;
                  }
                  paramsHtml += `</div>`;
                }
                return `<div class="tool-item" onclick="if(window.getSelection().toString())return;this.classList.toggle('params-expanded')"><span class="tool-item-name">${escapeHtml(t.name)}</span> - <span class="tool-item-desc">${escapeHtml(t.description)}</span> <span class="tool-params-hint"></span><div class="tool-params-content">${paramsHtml}</div></div>`;
              }).join('')}
            </div>
          </div>`;
      }

      // ============================================================
      // NAVIGATION
      // ============================================================

      // Cache for rendered entry DOM nodes
      // 按条目id缓存初次渲染DOM副本，切分支时clone；不缓存异步模型结果，不追踪entries内容或主题变更失效。
      const entryCache = new Map();

      // 输入原条目id，返回应滚动的DOM id字符串；toolResult本身无节点，改指其tool-call节点，其他用entry前缀。
      // 例如id中有&仍用原字符，getElementById找浏览器已解HTML实体的属性值，不二次escape也不拼CSS选择器。
      function getScrollTargetElementId(entryId) {
        const entry = byId.get(entryId);
        if (entry?.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId) {
          // getElementById() matches the parsed DOM id attribute, whose HTML entities
          // were already resolved from the escaped id rendered by renderToolCall().
          return `tool-call-${entry.message.toolCallId}`;
        }
        return `entry-${entryId}`;
      }

      // 输入条目，缓存命中返回深clone，未命中renderEntry→template解析→取首元素→存clone，返回节点或null；会分配DOM不直接挂载。
      // 例如toolResult返回空串所以不缓存节点；cloneNode(true)复制子树/内联属性，不复制addEventListener监听，外层导航会重新绑定复制按钮。
      function renderEntryToNode(entry) {
        // Check cache first
        if (entryCache.has(entry.id)) {
          return entryCache.get(entry.id).cloneNode(true);
        }

        // Render to HTML string, then parse to node
        const html = renderEntry(entry);
        if (!html) return null;

        // template是浏览器惰性内容容器，innerHTML解析已生成的片段，不是调用远端模板引擎。
        const template = document.createElement('template');
        template.innerHTML = html;
        // 只取首个元素，若某条目返回多个顶层元素，其余不由本函数附到消息列表。
        const node = template.content.firstElementChild;

        // Cache the node
        if (node) {
          // 缓存初始呈现副本，实际返回原node；页面展开状态稍后需重新应用到clone。
          entryCache.set(entry.id, node.cloneNode(true));
        }
        return node;
      }

      // 输入要作新叶的id、滚动模式和可选独立目标id，更新两侧DOM并安排滚动，无返回；不改原会话文件或浏览器URL历史。
      // 例如点树某中间节点：targetId用其贪心后代叶，scrollToEntryId用点击节点；路径仍是原始父链，不应用compaction投影。
      // target模式遇隐藏custom目标会自动显示；缓存clone需重绑事件/重套全局展开。setTimeout只延后滚动，连续导航未取消旧定时回调。
      function navigateTo(targetId, scrollMode = 'target', scrollToEntryId = null) {
        currentLeafId = targetId;
        // ||使空目标id回退叶id；当前叶/目标状态先写入，再据它们构造新页面。
        currentTargetId = scrollToEntryId || targetId;
        const targetEntry = byId.get(currentTargetId);
        if (scrollMode === 'target' && targetEntry?.type === 'custom_message' && targetEntry.display === false) {
          setHiddenMessagesVisible(true);
        }
        // 只取当前叶到根路径，右侧不受左侧filterMode/searchQuery删减。
        const path = getPath(targetId);

        renderTree();

        // 页头整体替换，旧按钮监听随旧节点移除，所以立即重新绑定。
        document.getElementById('header-container').innerHTML = renderHeader();
        attachHeaderHandlers();

        // Build messages using cached DOM nodes
        const messagesEl = document.getElementById('messages');
        // DocumentFragment先离屏收集节点，最后一次append减少逐项挂载；不会自动消除所有布局开销。
        const fragment = document.createDocumentFragment();

        for (const entry of path) {
          const node = renderEntryToNode(entry);
          if (node) {
            fragment.appendChild(node);
          }
        }

        // 清空旧消息DOM并挂新路径；条目原数据和entryCache不清空。
        messagesEl.innerHTML = '';
        messagesEl.appendChild(fragment);

        // Cached nodes contain their initial presentation; reapply the viewer's toggle states.
        // 初始clone含最初样式，重新施加查看者全局开关，不保留所有单张卡片的临时手动展开状态。
        setThinkingExpanded(thinkingExpanded);
        setToolOutputsExpanded(toolOutputsExpanded);

        // Attach click handlers for copy-link buttons
        messagesEl.querySelectorAll('.copy-link-btn').forEach(btn => {
          // 复制按钮阻止冒泡到折叠卡片，生成链接后调用浏览器复制；async返回未在此await。
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const entryId = btn.dataset.entryId;
            const shareUrl = buildShareUrl(entryId);
            copyToClipboard(shareUrl, btn);
          });
        });

        // Use setTimeout(0) to ensure DOM is fully laid out before scrolling
        setTimeout(() => {
          const content = document.getElementById('content');
          // bottom滚内容容器末尾，target定位节点，none等其他值不安排目标滚动。
          if (scrollMode === 'bottom') {
            content.scrollTop = content.scrollHeight;
          } else if (scrollMode === 'target') {
            // If scrollToEntryId is provided, scroll to that specific entry.
            // Tool result entries are rendered inside their assistant tool-call block,
            // so route them to the visible tool-call element instead.
            const scrollTargetId = scrollToEntryId || targetId;
            // 工具结果优先映射到可见调用区，再尝试普通entry节点；不存在就不滚动。
            const targetEl = document.getElementById(getScrollTargetElementId(scrollTargetId)) ||
              document.getElementById(`entry-${scrollTargetId}`);
            if (targetEl) {
              targetEl.scrollIntoView({ block: 'center' });
              // Briefly highlight the target message
              // 显式目标额外加2秒高亮；定时移除的是这次捕获的节点，即使后续导航已换DOM。
              if (scrollToEntryId) {
                targetEl.classList.add('highlight');
                setTimeout(() => targetEl.classList.remove('highlight'), 2000);
              }
            }
          }
        }, 0);
      }

      // ============================================================
      // INITIALIZATION
      // ============================================================

      // Configure marked with syntax highlighting and TUI-compatible HTML handling
      // 自定义删除线要求恰当的~~边界与非空白起止，\1引用第一组双波浪；无m时$只在整个候选输入末尾成立。
      const strictStrikethroughRegex = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

      // 修改本页面共享marked实例：GFM/换行、禁HTML tokenizer、自定义删除线/CJK强调、链接图片/代码渲染；不重新打包vendor。
      // marked扩展规则里false才回退旧tokenizer，undefined表示本规则不产token；所以html/tag返回undefined用于让原标签走文字路径。
      marked.use({
        // breaks需配合gfm=true，将普通段落中的换行也显示为换行，不把所有文字强制pre格式化。
        breaks: true,
        gfm: true,
        tokenizer: {
          // Treat HTML-like input as plain text so tags are shown verbatim,
          // matching the TUI markdown renderer.
          // 块级HTML不生成HTML token；tag同理处理行内标签，不是事后用正则删除已输出HTML。
          html() {
            return undefined;
          },
          tag() {
            return undefined;
          },
          // 输入当前位置Markdown，匹配成功返回del token和递归解析的内部tokens，失败undefined；不回退默认宽松删除线。
          // 例如~~x~~可匹配，~~ x~~因起始空白不匹配；this是marked tokenizer实例，提供lexer给内部文字分词。
          del(src) {
            const match = strictStrikethroughRegex.exec(src);
            if (!match) return undefined;
            // raw供词法器消费原串，text去定界符，tokens供renderer解析嵌套强调/链接等。
            return {
              type: 'del',
              raw: match[0],
              text: match[2],
              tokens: this.lexer.inlineTokens(match[2])
            };
          },
          // 只取插件的emStrong方法，不整体use插件，故插件自带del不会覆盖上面的严格删除线规则。
          emStrong: markedCjkFriendly().tokenizer.emStrong
        },
        renderer: {
          // Sanitize link URLs with a scheme allow-list. Browsers strip C0
          // controls from schemes, so strip them before checking and emitting.
          // 输入marked链接token，URL通过本页scheme检查后构造a，失败只保留已分词链接文字；不直接访问目标。
          // this.parser解析token.tokens以保留链接文字内部格式；href/title另作属性转义，不把scheme过滤当站点可信判断。
          link(token) {
            const href = sanitizeMarkdownUrl(token.href);
            // null表示明确拒绝；空串URL仍可生成空href，不等于错误。
            if (href === null) {
              return this.parser.parseInline(token.tokens);
            }
            let out = '<a href="' + escapeHtml(href) + '"';
            if (token.title) {
              out += ' title="' + escapeHtml(token.title) + '"';
            }
            out += '>' + this.parser.parseInline(token.tokens) + '</a>';
            return out;
          },
          // Sanitize image src URLs with the same scheme allow-list.
          // 输入图片token，URL不允许时只返回转义alt文字，允许时返回img HTML；浏览器后续加载远端图片可能联网。
          // token.text/title/src都按属性文字转义；这是Markdown图片路径，历史内嵌data URL图片另由renderEntry直接构造。
          image(token) {
            const href = sanitizeMarkdownUrl(token.href);
            if (href === null) {
              return escapeHtml(token.text || '');
            }
            let out = '<img src="' + escapeHtml(href) + '" alt="' + escapeHtml(token.text || '') + '"';
            if (token.title) {
              out += ' title="' + escapeHtml(token.title) + '"';
            }
            out += '>';
            return out;
          },
          // Code blocks: syntax highlight, no HTML escaping
          // 输入围栏代码token，有已注册语言按指定语法高亮，否则自动识别；异常退转义纯文字，再包pre/code返回。
          // 与上面formatExpandableOutput无lang不自动识别的规则不同；hljs只分析字符串，不运行代码，但自动识别可能误判语言。
          code(token) {
            const code = token.text;
            const lang = token.lang;
            let highlighted;
            // 不在这里下载新语法；getLanguage只查内嵌highlight.js注册表。
            if (lang && hljs.getLanguage(lang)) {
              try {
                highlighted = hljs.highlight(code, { language: lang }).value;
              } catch {
                highlighted = escapeHtml(code);
              }
            } else {
              // Auto-detect language if not specified
              try {
                highlighted = hljs.highlightAuto(code).value;
              } catch {
                highlighted = escapeHtml(code);
              }
            }
            return `<pre><code class="hljs">${highlighted}</code></pre>`;
          },
          // Inline code: escape HTML
          // 输入行内代码token，转义正文后包code标签，无高亮或执行；例如<x>显示字面尖括号。
          codespan(token) {
            return `<code>${escapeHtml(token.text)}</code>`;
          }
        }
      });

      // Simple marked parse (escaping handled in renderers)
      // 输入Markdown，按上面已配置marked返回HTML，不再额外清洗/捕获异常；例如中文强调由emStrong插件处理。
      // 名字safe不是任意HTML的通用安全保证，依赖既有tokenizer/renderer规则；本页未启用async选项，正常路径同步返回字符串。
      function safeMarkedParse(text) {
        return marked.parse(text);
      }

      // Search input
      // DOM节点需由template.html提供，未对缺节点全面兜底；input事件每次更新关键词并完整重建侧栏树。
      const searchInput = document.getElementById('tree-search');
      searchInput.addEventListener('input', (e) => {
        // event.target是触发输入的元素，读取当前值，不向模型提交搜索文字。
        searchQuery = e.target.value;
        forceTreeRerender();
      });

      // Filter buttons
      // 每个筛选按钮绑定闭包，先清其他active再设当前data-filter模式，立即强制重绘树。
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          filterMode = btn.dataset.filter;
          forceTreeRerender();
        });
      });

      // Sidebar toggle
      // 缓存侧栏/覆盖层/汉堡按钮/拖拽分隔条节点，随后只修改页面样式，不改导出数据。
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      const hamburger = document.getElementById('hamburger');
      const sidebarResizer = document.getElementById('sidebar-resizer');
      // localStorage按页面origin存偏好，不随HTML数据上传；版本化键让同origin的其他导出页也可复用宽度。
      const SIDEBAR_WIDTH_STORAGE_KEY = 'pi-share:v1:sidebar-width';
      // 尽量给正文保留320px，但最小侧栏优先，极窄屏下不保证两者总宽不溢出。
      const MIN_CONTENT_WIDTH = 320;

      // 无输入，查询当前视口是否<=900px，返回布尔；是布局断点而非检测用户设备操作系统。
      function isMobileLayout() {
        return window.matchMedia('(max-width: 900px)').matches;
      }

      // 无输入，读CSS自定义属性及视口宽，返回允许的侧栏宽度范围；有样式读取，无持久化。
      // 例如最大值取CSS上限和视口减320两者较小者，但至少minWidth；parseFloat失败/0用回退240/720，实际模板CSS最大值可另为840。
      function getSidebarBounds() {
        // getComputedStyle读当前根样式，parseFloat只取前导数值（如240px→240），不是通用CSS单位换算。
        const rootStyles = getComputedStyle(document.documentElement);
        const minWidth = parseFloat(rootStyles.getPropertyValue('--sidebar-min-width')) || 240;
        const maxWidth = parseFloat(rootStyles.getPropertyValue('--sidebar-max-width')) || 720;
        const viewportMaxWidth = window.innerWidth - MIN_CONTENT_WIDTH;
        return {
          minWidth,
          maxWidth: Math.max(minWidth, Math.min(maxWidth, viewportMaxWidth))
        };
      }

      // 输入宽度，按当前布局范围钳位返回，不写样式；例如超max取max，未验证NaN/任意对象输入。
      function clampSidebarWidth(width) {
        const { minWidth, maxWidth } = getSidebarBounds();
        return Math.max(minWidth, Math.min(maxWidth, width));
      }

      // 输入宽度，实时钳位/四舍五入后写根CSS变量，无返回/存储；例如401.4写401px，CSS负责真正布局。
      function applySidebarWidth(width) {
        document.documentElement.style.setProperty('--sidebar-width', `${Math.round(clampSidebarWidth(width))}px`);
      }

      // 无输入，读localStorage宽度，有限数字返回，否则null；例如无权限/无键/NaN均退null，不让偏好读取阻断页面。
      // Number空文字可变0，范围钳位留给apply；不把存储字符串当代码执行。
      function loadSidebarWidth() {
        try {
          const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
          if (raw === null) return null;
          const width = Number(raw);
          return Number.isFinite(width) ? width : null;
        } catch {
          return null;
        }
      }

      // 输入宽度，钳位/取整后写localStorage文字，无返回；例如拖拽结束保存，下次页面尝试恢复，存储异常安静忽略。
      function saveSidebarWidth(width) {
        try {
          localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(clampSidebarWidth(width))));
        } catch {
          // Ignore storage failures (e.g. private browsing restrictions)
        }
      }

      // 无输入，恢复已存宽度并注册桌面拖拽/双击/窗口变化监听；会改CSS/存储，不修改会话，正常只在初始化调用一次。
      // 拖拽按起点宽度+水平位移更新，结束/cancel统一释放监听并保存；不是通用多指拖拽状态机，没有销毁整页监听的返回函数。
      function setupSidebarResize() {
        const savedWidth = loadSidebarWidth();
        if (savedWidth !== null) {
          applySidebarWidth(savedWidth);
        }

        // 仅分隔条缺失有这一处早退；已存宽度此前仍可应用，其他DOM节点假定存在。
        if (!sidebarResizer) return;

        // 保存当前拖拽收尾闭包，无拖拽时null；后续指针事件触发它移除本次监听。
        let cleanupDrag = null;

        // 输入待释放指针id，有收尾函数则执行后置null，无返回；例如pointerup/cancel都复用此入口。
        const stopDrag = (pointerId) => {
          if (cleanupDrag) {
            cleanupDrag(pointerId);
            cleanupDrag = null;
          }
        };

        // 小屏不拖拽；桌面阻止默认选择并记录起始X/真实侧栏像素宽，若支持则请求指针捕获。
        sidebarResizer.addEventListener('pointerdown', (e) => {
          if (isMobileLayout()) return;

          e.preventDefault();
          const startX = e.clientX;
          const startWidth = sidebar.getBoundingClientRect().width;
          document.body.classList.add('sidebar-resizing');
          sidebarResizer.setPointerCapture?.(e.pointerId);

          // 输入移动事件，把水平差加到起始宽度后立即写CSS；不以每次上次宽度累计误差。
          const onPointerMove = (event) => {
            applySidebarWidth(startWidth + (event.clientX - startX));
          };

          // 输入结束指针id，清拖拽类/释放捕获/删window监听，并保存最终实际宽度；中途异常没有额外finally回滚。
          cleanupDrag = (pointerIdToRelease) => {
            document.body.classList.remove('sidebar-resizing');
            // ?.()只处理方法不存在，不吞掉方法本身抛错。
            sidebarResizer.releasePointerCapture?.(pointerIdToRelease);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerCancel);
            saveSidebarWidth(sidebar.getBoundingClientRect().width);
          };

          // 两个局部闭包分别接结束/取消事件并转交同一收尾逻辑，remove时用同一函数引用。
          const onPointerUp = (event) => stopDrag(event.pointerId);
          const onPointerCancel = (event) => stopDrag(event.pointerId);

          // 挂到window使指针移出分隔条仍跟踪；当前实现未按pointerId过滤每个move/up事件。
          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
          window.addEventListener('pointercancel', onPointerCancel);
        });

        // 双击桌面回到400（仍受clamp限制）并保存，不直接清掉存储键。
        sidebarResizer.addEventListener('dblclick', () => {
          if (isMobileLayout()) return;
          applySidebarWidth(400);
          saveSidebarWidth(400);
        });

        // 调视口时桌面重新钳当前宽度，小屏忽略，不自动清已存偏好。
        window.addEventListener('resize', () => {
          if (isMobileLayout()) return;
          applySidebarWidth(sidebar.getBoundingClientRect().width);
        });
      }

      // 实际运行初始化，前面的函数声明本身不会读localStorage或挂监听。
      setupSidebarResize();

      // 打开小屏侧栏/遮罩并隐藏汉堡按钮；不靠新路由或网络加载内容。
      hamburger.addEventListener('click', () => {
        sidebar.classList.add('open');
        overlay.classList.add('open');
        hamburger.style.display = 'none';
      });

      // 无输入/返回，去掉open类并恢复按钮默认display，供遮罩和关闭按钮共用，不清筛选/宽度偏好。
      const closeSidebar = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
        hamburger.style.display = '';
      };

      overlay.addEventListener('click', closeSidebar);
      document.getElementById('sidebar-close').addEventListener('click', closeSidebar);

      // Toggle states
      // 只在本次页面内保存三种展示开关；重载不从localStorage恢复，不更改会话里的思考/隐藏标记。
      let thinkingExpanded = true;
      let toolOutputsExpanded = false;
      let showHiddenMessages = false;

      // 输入是否显示终端隐藏custom消息，更新状态/body类和页头按钮，无返回；例如深链接到隐藏条目可自动true。
      // CSS隐藏不删除DOM/JSON，也不改变原entry.display；按钮缺失则只更新状态和body。
      function setHiddenMessagesVisible(visible) {
        showHiddenMessages = visible;
        document.body.classList.toggle('show-hidden-messages', visible);
        const button = document.querySelector('[data-action="toggle-hidden-messages"]');
        if (button) {
          // ARIA状态需字符串，textContent只写固定文字，不解析HTML。
          button.setAttribute('aria-pressed', String(visible));
          button.textContent = visible ? 'Hide hidden messages' : 'Show hidden messages';
        }
      }

      // 输入展开布尔，更新共享状态/按钮ARIA和当前DOM思考正文、折叠占位的display，无数据删除或模型调用。
      // 例如false隐藏thinking-text并显示Thinking...；仅处理当前已挂载节点，导航后会重套此状态。
      function setThinkingExpanded(expanded) {
        thinkingExpanded = expanded;
        document.querySelector('[data-action="toggle-thinking"]')?.setAttribute('aria-pressed', String(expanded));
        document.querySelectorAll('.thinking-text').forEach(el => {
          el.style.display = thinkingExpanded ? '' : 'none';
        });
        document.querySelectorAll('.thinking-collapsed').forEach(el => {
          el.style.display = thinkingExpanded ? 'none' : 'block';
        });
      }

      // 输入展开布尔，统一修改当前可展开工具输出、压缩卡片和skill调用的expanded类，保存全局状态，无返回。
      // 例如O同时展开这三类；不涵盖system-prompt或工具参数列表的所有独立展开，也不读取临时全文。
      function setToolOutputsExpanded(expanded) {
        toolOutputsExpanded = expanded;
        document.querySelector('[data-action="toggle-tools"]')?.setAttribute('aria-pressed', String(expanded));
        document.querySelectorAll('.tool-output.expandable').forEach(el => {
          el.classList.toggle('expanded', toolOutputsExpanded);
        });
        document.querySelectorAll('.compaction').forEach(el => {
          el.classList.toggle('expanded', toolOutputsExpanded);
        });
        document.querySelectorAll('.skill-invocation').forEach(el => {
          el.classList.toggle('expanded', toolOutputsExpanded);
        });
      }

      // 无输入/返回，为当前页头三个按钮挂反转状态的click闭包；页头替换后再调用，否则旧节点监听不会自动迁移。
      const attachHeaderHandlers = () => {
        document.querySelector('[data-action="toggle-thinking"]')?.addEventListener('click', () => {
          setThinkingExpanded(!thinkingExpanded);
        });
        document.querySelector('[data-action="toggle-tools"]')?.addEventListener('click', () => {
          setToolOutputsExpanded(!toolOutputsExpanded);
        });
        document.querySelector('[data-action="toggle-hidden-messages"]')?.addEventListener('click', () => {
          setHiddenMessagesVisible(!showHiddenMessages);
        });
      };

      // 输入当前焦点元素，返回是否应避免快捷键的真值；input/textarea/select/button或contenteditable区域通过，空元素false。
      // element.isContentEditable可能原值undefined，最后Boolean只包closest结果；不是严格验证任意未知对象的DOM类型。
      const isEditableTarget = (element) => {
        if (!element) return false;
        const tagName = element.tagName;
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON') {
          return true;
        }
        return element.isContentEditable || Boolean(element.closest?.('[contenteditable="true"]'));
      };

      // Keyboard shortcuts
      // 全页键盘监听：Escape先清关键词并回初始叶底部；之后有Ctrl/Meta/Alt或编辑焦点则不处理T/O/H，Shift不在过滤项。
      // 因Escape在焦点过滤之前，即使输入框聚焦仍会清搜索/导航，且未preventDefault；这里只展示快捷键，不沿用Pi终端按键配置。
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          searchQuery = '';
          // 此处未forceTreeRerender，沿用导航轻更新机制；也不恢复filterMode为default或移除URL查询参数。
          navigateTo(leafId, 'bottom');
        }

        if (e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(document.activeElement)) {
          return;
        }

        // 转小写让Shift+T也识别t；只在命中t/o/h时阻止浏览器默认行为。
        const key = e.key.toLowerCase();
        if (key === 't') {
          e.preventDefault();
          setThinkingExpanded(!thinkingExpanded);
        } else if (key === 'o') {
          e.preventDefault();
          setToolOutputsExpanded(!toolOutputsExpanded);
        } else if (key === 'h') {
          e.preventDefault();
          setHiddenMessagesVisible(!showHiddenMessages);
        }
      });

      // Initial render
      // If URL has targetId, scroll to that specific message; otherwise stay at top
      // 初始化晚于DOM监听和展示状态变量，调用函数时不会读到尚未初始化的let；leafId真值不代表byId必有它。
      if (leafId) {
        // 目标存在才用深链接滚动，但不验证目标属于所选叶父链；找不到对应DOM时滚动代码安静跳过。
        if (urlTargetId && byId.has(urlTargetId)) {
          // Deep link: navigate to leaf and scroll to target message
          navigateTo(leafId, 'target', urlTargetId);
        } else {
          navigateTo(leafId, 'none');
        }
      // 没有默认叶才用最后存储条目id，不搜索全局最新叶时间；无entries则不导航，也不额外生成空页头。
      } else if (entries.length > 0) {
        // Fallback: use last entry if no leafId
        navigateTo(entries[entries.length - 1].id, 'none');
      }
    })();
