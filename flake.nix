{
  description = "Flake template";
  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    dave-shield.url = "github:dczmer/dave-shield";
  };
  outputs =
    {
      nixpkgs,
      flake-utils,
      dave-shield,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        extraPkgs = with pkgs; [
          nodejs
          prettierd
          rtk
          mdl
          gh
        ];
        extraCombinators = with dave-shield.lib.${system}.jailCombinators; [
          # HACK to make npm scripts run
          (readonly (noescape "/usr/bin/env"))
        ];
        daveShield = dave-shield.lib.${system}.daveShield;
        makeJailedPi = dave-shield.lib.${system}.makeJailedPi;
      in
      rec {
        packages = {
          jailedPi = makeJailedPi {
            inherit extraPkgs extraCombinators;
          };
          jailedShell = daveShield {
            exec = pkgs.bash;
            inherit extraPkgs extraCombinators;
          };
        };
        devShells = {
          default = pkgs.mkShell {
            buildInputs = [
              packages.jailedPi
            ]
            ++ extraPkgs;
            shellHook = ''

            '';
          };
        };
      }
    );
}
