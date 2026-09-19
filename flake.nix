{
  description = "Nix devShell for dave-pi-extensions package";
  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in
      {
        devShells = {
          default = pkgs.mkShell {
            buildInputs = [
              # extra tools for the devShell go here
              pkgs.perl
              pkgs.python3
              pkgs.fd
            ];
            shellHook = ''

            '';
          };
        };
      }
    );
}
