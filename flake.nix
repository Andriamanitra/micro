{
  description = "micro with the libghostty-based terminal emulator";

  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.xz";
    zig = {
      url = "github:mitchellh/zig-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, zig, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);

      # Keep this in sync with the GIT_TAG in go-libghostty's CMakeLists.txt.
      ghosttyRev = "66af4c7458db7e19ae7adb44aa7054879be58b6b";
      zigVersion = "0.17.1";
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          zigPkg = zig.packages.${system}.${zigVersion};
          # go.mod requires Go 1.26 or newer.
          goPkg = pkgs.go_1_26 or pkgs.go;
        in
        {
          default = pkgs.mkShell {
            packages = [
              goPkg
              pkgs.gopls
              pkgs.pkg-config
              zigPkg
              pkgs.git
              pkgs.curl
            ];

            shellHook = ''
              export CGO_ENABLED=1
              export LIBGHOSTTY_DIR="''${LIBGHOSTTY_DIR:-$PWD/build/libghostty}"
              export LIBGHOSTTY_SRC="''${LIBGHOSTTY_SRC:-$LIBGHOSTTY_DIR/ghostty}"
              export LIBGHOSTTY_PREFIX="''${LIBGHOSTTY_PREFIX:-$LIBGHOSTTY_DIR/prefix}"
              export PKG_CONFIG_PATH="$LIBGHOSTTY_PREFIX/lib/pkgconfig''${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
              export LD_LIBRARY_PATH="$LIBGHOSTTY_PREFIX/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
              export DYLD_LIBRARY_PATH="$LIBGHOSTTY_PREFIX/lib''${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"

              # Fetch Ghostty at the revision pinned by go-libghostty and build libghostty-vt
              build-libghostty() (
                set -eu
                prefix="$LIBGHOSTTY_PREFIX"
                src="$LIBGHOSTTY_SRC"

                if [ -f "$prefix/include/ghostty/vt.h" ] && ls "$prefix"/lib/libghostty-vt* >/dev/null 2>&1 \
                   && [ -f "$prefix/lib/pkgconfig/libghostty-vt-static.pc" ]; then
                  return 0
                fi

                if [ ! -d "$src/.git" ]; then
                  rm -rf "$src"
                  mkdir -p "$src"
                  git -C "$src" init -q
                  git -C "$src" remote add origin https://github.com/ghostty-org/ghostty.git
                fi

                git -C "$src" fetch --depth 1 origin "${ghosttyRev}"
                git -C "$src" checkout -q --detach FETCH_HEAD
                (
                  cd "$src"
                  zig build -Demit-lib-vt -Doptimize=ReleaseFast -Dtarget=$(uname -m)-linux-musl --prefix "$prefix"
                )
              )

              if [ "''${SKIP_LIBGHOSTTY_BUILD:-0}" != "1" ]; then
                build-libghostty || {
                  echo "warning: failed to build libghostty-vt" >&2
                  echo "fix the error above, or set SKIP_LIBGHOSTTY_BUILD=1 to use a system installation" >&2
                }
              fi
            '';
          };
        });

      formatter = forAllSystems (system:
        nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
