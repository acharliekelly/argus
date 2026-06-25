from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent
SERVE_ROOT = Path("/tmp/argus-fixture")
PACKAGE = SERVE_ROOT / "argus-demo-v2.zip"


def build_package() -> None:
    SERVE_ROOT.mkdir(parents=True, exist_ok=True)
    with ZipFile(PACKAGE, "w", ZIP_DEFLATED) as archive:
        for path in sorted((ROOT / "v2").rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(ROOT / "v2"))


if __name__ == "__main__":
    build_package()
    handler = partial(SimpleHTTPRequestHandler, directory=SERVE_ROOT)
    server = ThreadingHTTPServer(("0.0.0.0", 8080), handler)
    server.serve_forever()
