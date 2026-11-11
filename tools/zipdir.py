"""Zip the files of a directory (flat) into an archive: python -I zipdir.py out.zip dir"""
import os
import sys
import zipfile

out, src = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name in sorted(os.listdir(src)):
        z.write(os.path.join(src, name), name)
