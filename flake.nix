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
          deno
          prettierd
          typescript-language-server
          eslint

          # TODO: why isn't this available in the agent env?
          rtk
        ];
        extraCombinators = [
        ];
        makeJailedPi = dave-shield.lib.${system}.makeJailedPi;
      in
      rec {
        packages = {
          jailedPi = makeJailedPi {
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
