{
  description = "Gnosis VPN network intelligence dashboard";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        inherit (pkgs) lib;

        version = (lib.importJSON ./package.json).version;

        # Built with Next's standalone output: `server.js` plus only the traced
        # dependencies, rather than the whole production dependency tree.
        bloklune = pkgs.buildNpmPackage {
          pname = "bloklune";
          inherit version;

          src = lib.cleanSourceWith {
            src = ./.;
            # Keep the build input to what `next build` actually reads, so editing
            # the README or a workflow does not invalidate the derivation.
            filter =
              path: type:
              let
                base = baseNameOf path;
                relative = lib.removePrefix (toString ./. + "/") (toString path);
                topLevel = lib.head (lib.splitString "/" relative);
              in
              !(lib.hasPrefix "." base)
              && base != "node_modules"
              && base != "Dockerfile"
              && base != "README.md"
              && (relative == topLevel -> lib.elem topLevel [
                "app"
                "lib"
                "public"
                "sql"
                "next.config.ts"
                "package.json"
                "package-lock.json"
                "tsconfig.json"
              ]);
          };

          # Refresh with: nix run nixpkgs#prefetch-npm-deps -- package-lock.json
          npmDepsHash = "sha256-CDR/d6SVw57TRRvHXKn6XQ0Dv67u1NBAbS7CA/XtCwM=";

          env.NEXT_TELEMETRY_DISABLED = "1";

          # `next build` writes the tree itself; there is nothing to `npm pack`.
          dontNpmInstall = true;

          installPhase = ''
            runHook preInstall

            mkdir -p $out/share/bloklune
            cp -r .next/standalone/. $out/share/bloklune/
            # Standalone omits these two: static assets are served from disk, and
            # the SQL is read at runtime relative to the working directory.
            cp -r .next/static $out/share/bloklune/.next/static
            cp -r public $out/share/bloklune/public
            cp -r sql $out/share/bloklune/sql

            mkdir -p $out/bin
            # Next reads HOSTNAME for its bind address, but HOSTNAME is also a
            # standard shell variable, so --set-default would leave the server
            # trying to bind to the machine's name. Take the address from an
            # app-specific variable instead.
            makeWrapper ${lib.getExe pkgs.nodejs_22} $out/bin/bloklune \
              --add-flags $out/share/bloklune/server.js \
              --set-default NODE_ENV production \
              --set-default PORT 3000 \
              --run 'export HOSTNAME="''${BLOKLUNE_HOST:-0.0.0.0}"' \
              --run "cd $out/share/bloklune"

            runHook postInstall
          '';

          nativeBuildInputs = [ pkgs.makeWrapper ];
        };

        # dockerTools produces Linux images, so this is only meaningful when the
        # build itself targets Linux.
        container = pkgs.dockerTools.buildLayeredImage {
          name = "ghcr.io/jeandemeusy/bloklune";
          tag = "latest";

          # Reproducible by default: a fixed creation date keeps the image digest
          # stable when the contents have not changed.
          created = "1970-01-01T00:00:00Z";

          contents = [
            bloklune
            # CA certificates for outbound HTTPS to the configured RPC endpoint.
            pkgs.cacert
          ];

          config = {
            Cmd = [ "${bloklune}/bin/bloklune" ];
            ExposedPorts."3000/tcp" = { };
            Env = [
              "NODE_ENV=production"
              "HOSTNAME=0.0.0.0"
              "PORT=3000"
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            ];
            WorkingDir = "${bloklune}/share/bloklune";
          };
        };
      in
      {
        packages = {
          default = bloklune;
          inherit bloklune;
        }
        // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux { inherit container; };

        devShells.default = pkgs.mkShell {
          # package.json requires Node >= 22.13; nodejs_22 ships npm alongside it.
          packages = [
            pkgs.nodejs_22
            # psql, for poking at a Blokli index database directly.
            pkgs.postgresql_16
          ];

          shellHook = ''
            echo "bloklune · node $(node --version) · npm $(npm --version)"
            echo "  npm install           install dependencies"
            echo "  npm run dev           run against DATABASE_URL"
            echo "  npm run dev:fixtures  run on synthetic data, no database needed"
          '';
        };
      }
    );
}
