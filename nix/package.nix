# Nix打包配方：先离线编译并打包工作区，再用安装锁组装Pi运行目录、包装命令和安装自检。
# 整个文件是接属性集合的函数，callPackage按下面名字补依赖；返回derivation，真正构建时才执行各phase。
# 例由flake传source=self会编译该检出源码；读取JSON/构建失败直接由Nix报错，不在这里提供回滚。
{
  # Linux上修复原生扩展ELF依赖路径的构建钩子，Darwin不会加入nativeBuildInputs。
  autoPatchelfHook,
  # 提供Pi文件查找所用fd命令。
  fd,
  # 按固定hash取得发布模型目录的构建输入。
  fetchurl,
  # 把npm锁转换为Nix依赖并提供安装配置钩子。
  importNpmLock,
  # Nixpkgs通用函数库，供读JSON、条件列表、PATH和元数据使用。
  lib,
  # Linux原生图形/剪贴板扩展所需的XCB库。
  libxcb,
  # 生成设置PATH并传固定参数的可执行包装器。
  makeWrapper,
  # 固定选择Node 22系列的nixpkgs包，而非构建机PATH上的任意node。
  nodejs_22,
  # 提供Pi文本搜索所用rg命令。
  ripgrep,
  # 上游调用方传入的仓库源码路径/flake，读取元数据和编译都以它为根。
  source,
  # 标准构建环境，提供mkDerivation、平台信息和Linux编译器运行库。
  stdenv,
  # Linux Wayland剪贴板工具包。
  wl-clipboard,
  # Linux X11剪贴板命令。
  xclip,
}:

# let里定义两阶段打包共享值，in后返回最终安装包。
let
  # 局部别名便于后面统一使用同一Node版本。
  nodejs = nodejs_22;
  # 读取coding-agent清单，后面直接复用version/description；本表达式不修改package.json。
  packageJson = lib.importJSON (source + "/packages/coding-agent/package.json");
  # Lockfile root used by the pi.dev installer. It pins the coding agent's
  # runtime dependency tree and is kept in sync with package-lock.json by
  # `npm run check`.
  # 这是安装器的独立锁目录；第一阶段工作区构建仍使用仓库根锁。
  installLock = source + "/packages/coding-agent/install-lock";
  # 读本目录的revision字符串，严格JSON不能直接塞中文注释，详解在本轮配置配套文档。
  modelCatalogPin = lib.importJSON ./model-catalog.json;
  # 固定输出下载：声明URL与预期SHA-256；真正获取输入时不匹配就使构建失败。
  modelCatalog = fetchurl {
    # 存储路径的人类可读文件名，不参与选择provider。
    name = "pi-model-catalog.json";
    # The typed catalog is the representation whose bytes the revision hashes.
    # 必须请求三类typed目录，其响应字节才与revision使用的摘要表示一致。
    url = "https://pi.dev/api/models/revisions/${modelCatalogPin.revision}?types=chat,image,classifier";
    # revision是sha256-加十六进制摘要；这里去掉文字前缀后交fetchurl校验，不是重新计算远端摘要。
    sha256 = lib.removePrefix "sha256-" modelCatalogPin.revision;
  };

  # 第一阶段：以完整仓库为输入，产出七个npm包tarball供最终安装覆盖工作区依赖。
  workspacePackages = stdenv.mkDerivation {
    # 第一阶段的derivation名称与最终Pi运行包不同。
    pname = "pi-workspace-packages";
    # inherit (x) y等价于y = x.y，版本取coding-agent清单。
    inherit (packageJson) version;
    # 标准unpack阶段以仓库源码作为输入。
    src = source;

    # 按仓库根锁创建依赖集合；Nix预取依赖与后面的离线npm构建是不同阶段。
    npmDeps = importNpmLock { npmRoot = source; };
    # npm重建依赖时不运行依赖的生命周期脚本；并不禁止下面显式npm run build。
    npmRebuildFlags = [ "--ignore-scripts" ];

    # 构建机器上使用的工具/钩子，和最终运行PATH分别配置。
    nativeBuildInputs = [
      # 为水合器与npm脚本提供Node。
      nodejs
      # 让构建的npm配置使用Nix导入的锁依赖。
      importNpmLock.npmConfigHook
    ];

    # Nix的两个单引号界定多行shell文本，内部${modelCatalog}在求值时插入固定下载路径。
    # 依次执行preBuild钩子、本地水合、根build:offline、postBuild钩子；水合读模型目录并写provider data，不访问实时目录。
    # build:offline仍执行各包构建脚本，只把AI的在线模型生成替换成已有数据校验/编译，不等于空操作。
    buildPhase = ''
      runHook preBuild
      node packages/ai/scripts/hydrate-model-catalog.ts ${modelCatalog}
      npm run build:offline
      runHook postBuild
    '';

    # 第一阶段安装脚本文字保持原样。preInstall后定义pack_package(package_dir, output_name)，把包压成$out/name.tgz。
    # 函数局部保存目录/输出名及tarball；子shell先cd包目录，npm pack禁生命周期且把tarball写TMPDIR，再mv到输出。
    # 例如packages/ai、ai会得到$out/ai.tgz；mkdir先建$out，再按telemetry→ai→tui→agent→codemode→mcp→coding-agent调用。
    # 每次pack可能读文件/写归档，失败由标准构建shell规则传播；最后才运行postInstall，不自行发布npm包。
    installPhase = ''
      runHook preInstall

      pack_package() {
        local package_dir="$1"
        local output_name="$2"
        local tarball

        tarball="$(cd "$package_dir" && npm pack --ignore-scripts --silent --pack-destination "$TMPDIR")"
        mv "$TMPDIR/$tarball" "$out/$output_name.tgz"
      }

      mkdir -p "$out"
      pack_package packages/telemetry telemetry
      pack_package packages/ai ai
      pack_package packages/tui tui
      pack_package packages/agent agent
      pack_package packages/codemode codemode
      pack_package packages/mcp mcp
      pack_package packages/coding-agent coding-agent

      runHook postInstall
    '';
  };

  # 第二阶段依赖从安装锁取得，用上一阶段tarball替换内部包的注册表来源。
  npmDeps = importNpmLock {
    # npmRoot是安装锁目录，不是完整工作区根。
    npmRoot = installLock;
    # The install lock points internal packages at registry releases. Replace
    # them with the packages built from this checkout.
    # 键是锁中的node_modules路径，值是第一阶段输出中的本地归档；不直接修改原安装锁JSON。
    packageSourceOverrides = {
      # agent-core的注册表包替换成当前仓库编译的agent.tgz。
      "node_modules/@earendil-works/pi-agent-core" = workspacePackages + "/agent.tgz";
      # AI运行代码和已水合模型数据来自本次构建。
      "node_modules/@earendil-works/pi-ai" = workspacePackages + "/ai.tgz";
      # codemode使用本次构建的运行时包。
      "node_modules/@earendil-works/pi-codemode" = workspacePackages + "/codemode.tgz";
      # coding-agent CLI本身也替换成当前源码产物。
      "node_modules/@earendil-works/pi-coding-agent" = workspacePackages + "/coding-agent.tgz";
      # MCP客户端/协议包使用本次归档。
      "node_modules/@earendil-works/pi-mcp" = workspacePackages + "/mcp.tgz";
      # telemetry使用本次归档。
      "node_modules/@earendil-works/pi-telemetry" = workspacePackages + "/telemetry.tgz";
      # TUI代码及其发布文件清单内原生资源来自本次归档。
      "node_modules/@earendil-works/pi-tui" = workspacePackages + "/tui.tgz";
    };
  };
in
# 返回第二阶段运行包的构建描述，不把workspacePackages本身作为用户入口。
stdenv.mkDerivation {
  # 最终包名。
  pname = "pi";
  # 版本仍取coding-agent package.json。
  inherit (packageJson) version;
  # 这一阶段以小型安装锁目录为源，内部包代码由npmDeps覆盖提供。
  src = installLock;
  # 引用let里的第二阶段依赖集合，等价于npmDeps = npmDeps。
  inherit npmDeps;

  # 安装锁重建也禁依赖生命周期脚本，不等于卸载所有原生模块。
  npmRebuildFlags = [ "--ignore-scripts" ];

  # 构建工具在所有系统有Node、npm配置钩子与包装器生成工具。
  nativeBuildInputs = [
    nodejs
    importNpmLock.npmConfigHook
    makeWrapper
  ]
  # ++拼列表，optionals为真时加autoPatchelfHook，否则加空列表；不在Darwin修ELF。
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  # 运行/链接所需Node在所有平台加入；Linux另加C++运行库和XCB供原生模块使用。
  buildInputs = [ nodejs ] ++ lib.optionals stdenv.hostPlatform.isLinux [
    # 标准编译器的运行库输出，不是再编译整个Node。
    stdenv.cc.cc.lib
    # 为相应原生扩展提供XCB动态库。
    libxcb
  ];

  # 第二阶段直接装已编译包，不执行标准buildPhase。
  dontBuild = true;
  # 禁标准strip步骤，避免对预编译原生资源做默认裁剪。
  dontStrip = true;

  # 最终安装依次preInstall、创建lib/pi与bin、复制安装目录、makeWrapper、postInstall；原脚本文字不改。
  # 包装器用绝对node启动dist/bundle/cli.js；Node的bin后置PATH，让工具启动的shell优先保留用户原node/npm。
  # fd/rg则前置；Linux再前置wl-clipboard/xclip，${lib.makeBinPath ...}把这些包的bin目录拼成冒号分隔PATH。
  # 这是包装命令的启动环境；不在打包期间读写用户剪贴板，运行时Pi仍可能按用户动作调用这些命令。
  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/pi" "$out/bin"
    cp -R . "$out/lib/pi"

    # The wrapper runs Pi with an absolute Node path. Node is only on PATH so Pi can
    # find npm for package installs; append it so that shells started by the
    # bash tool keep the user's node/npm (e.g. from mise or nvm). fd, ripgrep,
    # and the clipboard tools are Pi's own dependencies and take precedence.
    makeWrapper ${nodejs}/bin/node "$out/bin/pi" \
      --add-flags "$out/lib/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
      --suffix PATH : ${lib.makeBinPath [ nodejs ]} \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            fd
            ripgrep
          ]
          ++ lib.optionals stdenv.hostPlatform.isLinux [
            wl-clipboard
            xclip
          ]
        )
      }

    runHook postInstall
  '';

  # 打开安装完成后的自检阶段，不是开启全仓单元测试。
  doInstallCheck = true;
  # 自检先比对pi --version与清单版本；随后Node脚本逐个require当前OS/架构目录内的.node模块。
  # fs/path是Node内置模块；dir用process.platform/process.arch拼成TUI原生预构建目录；目录存在才readdir并筛.node。
  # require失败使构建失败，目录不存在则这段不会据此报错；最后单独require photon-node，再postInstallCheck。
  # 加载原生扩展和仅打印版本不等于已经实际测过剪贴板复制/粘贴或模型请求；内嵌JS和shell正文均保留原字节。
  installCheckPhase = ''
    runHook preInstallCheck
    test "$("$out/bin/pi" --version)" = "${packageJson.version}"
    # Load host-platform TUI helpers directly so missing native dependencies
    # fail the build rather than silently disabling clipboard support.
    ${nodejs}/bin/node -e \
      "const fs = require('node:fs');
       const path = require('node:path');
       const dir = '$out/lib/pi/node_modules/@earendil-works/pi-tui/native/' + process.platform + '/prebuilds/' + process.platform + '-' + process.arch;
       if (fs.existsSync(dir)) {
         for (const file of fs.readdirSync(dir)) {
           if (file.endsWith('.node')) require(path.join(dir, file));
         }
       }"
    ${nodejs}/bin/node -e \
      "require('$out/lib/pi/node_modules/@silvia-odwyer/photon-node')"
    runHook postInstallCheck
  '';

  # 元数据供Nix工具展示/筛选，不参与CLI参数解析。
  meta = {
    # 复用npm清单描述。
    description = packageJson.description;
    # 项目主页文字。
    homepage = "https://pi.dev";
    # MIT许可证元数据；实际源码许可仍以仓库许可证为准。
    license = lib.licenses.mit;
    # 指明包内主要程序名pi。
    mainProgram = "pi";
    # 声明目标四平台，与flake systems对应，不等于本机已成功编译所有目标。
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    # with让列表可直接使用lib.sourceTypes里的名称：包同时含源码构建和预编译原生代码。
    sourceProvenance = with lib.sourceTypes; [
      # TypeScript/JavaScript工作区由源码构建。
      fromSource
      # 随包的原生扩展有预编译二进制来源，未声称全部原生代码在此重编。
      binaryNativeCode
    ];
  };
}
