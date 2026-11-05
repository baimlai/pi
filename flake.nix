# Nix flake入口：按系统公开Pi包、可运行app和overlay，构建细节交给nix/package.nix。
# 属性集合用{...}，赋值以分号结尾；它描述构建结果，不是在这里直接执行npm或启动Pi。
{
  # flake的人类可读说明，不决定npm包名或版本。
  description = "Pi coding agent";

  # 外部输入由flake.lock固定实际修订；这里的URL描述要跟踪的来源分支。
  inputs = {
    # 默认系统使用nixpkgs的滚动不稳定分支定义。
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # nixpkgs unstable no longer supports Intel macOS. Keep using the final
    # Darwin branch that does so for pi's x86_64-darwin package.
    # Intel macOS单独选仍提供该平台支持的分支，其他三个系统不走这一输入。
    nixpkgs-darwin-x64.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

  };

  # outputs接收自身源码和两个已解析输入，返回packages/apps/overlays属性；实际构建可失败，不由此函数吞错。
  # 例如packages.x86_64-linux.default选Linux包；Nix惰性求值按需要展开，声明输出不等于已经编译四个平台。
  outputs =
    {
      # self代表本flake，可作构建源码，也可引用本文件定义的其他输出。
      self,
      # 默认nixpkgs输入集合；这里不是已经import过的某一系统包集合。
      nixpkgs,
      # 连字符允许出现在Nix属性/标识符中，不表示减法表达式。
      nixpkgs-darwin-x64,
    }:
    # let声明后续输出共享的局部值，in之后才是这次函数返回的表达式。
    let
      # 支持的四个Nix系统标识；列表元素之间用空白分隔，不用逗号。
      systems = [
        # Apple Silicon上的macOS。
        "aarch64-darwin"
        # ARM64 Linux。
        "aarch64-linux"
        # Intel macOS。
        "x86_64-darwin"
        # x86-64 Linux。
        "x86_64-linux"
      ];
      # genAttrs先接系统名列表，得到“再接一个回调”的函数；例如回调返回x就为四个名字分别求值。
      forAllSystems = nixpkgs.lib.genAttrs systems;
      # 接system字符串，返回对应nixpkgs输入；if表达式只选一个分支，不启动任何目标系统。
      nixpkgsFor = system: if system == "x86_64-darwin" then nixpkgs-darwin-x64 else nixpkgs;
      # 接system，导入该系统的包集合，再让callPackage按参数名注入构建依赖；返回derivation而非已执行命令。
      # 例传aarch64-linux会用默认nixpkgs，传x86_64-darwin才改用兼容分支；source显式绑定当前flake。
      packageFor =
        system:
        let
          # inherit system等价于system = system；import按该系统实例化nixpkgs。
          pkgs = import (nixpkgsFor system) { inherit system; };
        in
        # callPackage从pkgs补齐package.nix的形参，source由当前调用覆盖，不猜Git远程地址。
        pkgs.callPackage ./nix/package.nix { source = self; };
    in
    {
      # 回调接每个系统名并返回该系统的两个包入口；两项都按相同配方构造Pi。
      packages = forAllSystems (system: {
        # nix build .默认选择当前系统的default包。
        default = packageFor system;
        # 显式的pi包名入口，例如.#pi。
        pi = packageFor system;
      });

      # 为每个系统组装可运行的app元数据；不是在求值时启动可执行程序。
      apps = forAllSystems (system: {
        # 默认app供nix run使用。
        default = {
          # Nix app输出要求的类型标记。
          type = "app";
          # 双引号内${...}求值插入当前系统包的store路径，最后指向包装后的bin/pi。
          program = "${self.packages.${system}.default}/bin/pi";
          # app的人类可读描述，与包的meta可分别存在。
          meta.description = "Pi coding agent";
        };
        # pi app直接引用同系统的default定义，不另造另一条启动命令。
        pi = self.apps.${system}.default;
      });

      # overlay按约定接最终包集final和前一包集_previous，返回新增属性；下划线表示后者在这里不用。
      # 消费方把此overlay加入nixpkgs后得到pkgs.pi；依赖取消费方的final包集，而非强制用上面packageFor。
      overlays.default = final: _previous: {
        # 仍使用当前flake源码，依赖注入由消费方最终包集合完成。
        pi = final.callPackage ./nix/package.nix { source = self; };
      };
    };
}
