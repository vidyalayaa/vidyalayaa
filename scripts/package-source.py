"""Create a credential-free source release, including the deployment PDF."""
from pathlib import Path
import zipfile,hashlib,json,os
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output';OUT.mkdir(exist_ok=True)
archive=OUT/'vidyalayaa-source.zip'
skip={'node_modules','.git','.pio','tmp','test-results','playwright-report','credentials','dist','__pycache__'}
files=[]
for directory,dirs,names in os.walk(ROOT):
 dirs[:]=[d for d in dirs if d not in skip and not (Path(directory).relative_to(ROOT)==Path('docs') and d=='source')]
 for name in names:
  path=Path(directory)/name;rel=path.relative_to(ROOT)
  if path.name.startswith('.env') and path.name!='.env.example':continue
  if path.name in {'provisioning.h','.firebaserc'} or path.suffix in {'.pem','.key','.zip'}:continue
  if rel.parts[0]=='output' and not (rel.parts[1:2]==('pdf',) or path.name.startswith('preview-') or path.name=='verification.json'):continue
  files.append(path)
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for path in sorted(files):z.write(path,Path('vidyalayaa')/path.relative_to(ROOT))
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(OUT/'vidyalayaa-source.zip.sha256').write_text(digest+'  vidyalayaa-source.zip\n')
(OUT/'source-manifest.json').write_text(json.dumps({'archive':archive.name,'sha256':digest,'file_count':len(files),'files':[str(x.relative_to(ROOT)).replace('\\','/') for x in sorted(files)]},indent=2)+'\n')
print(f'{archive}: {len(files)} files, {archive.stat().st_size} bytes')
