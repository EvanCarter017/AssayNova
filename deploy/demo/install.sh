#!/usr/bin/env bash
# Explicit one-time demo installation; existing unrelated services stay untouched.
set -euo pipefail
umask 077
fail() { printf '%s\n' "AssayNova demo stopped: $1" >&2; exit 1; }
[[ ${EUID} == 0 ]] || fail 'run this reviewed script with sudo'
[[ $# == 3 && $1 == prepare || $# == 1 && $1 == enable-https ]] || fail 'use prepare STAGING COMMIT or enable-https'
app=/srv/assaynova-demo
data=/var/lib/assaynova-demo
runtime=/opt/assaynova-demo
site=/etc/nginx/sites-available/assaynova-demo
enabled=/etc/nginx/sites-enabled/assaynova-demo
unit=/etc/systemd/system/assaynova-demo.service
webroot=/var/www/assaynova-acme
marker='AssayNova demo installer v1'
check_path() {
    local current=$1
    [[ $current == /* && $current != / && $current != *'/../'* && $current != *'/./'* ]] || fail 'invalid owned path'
    while [[ $current != / ]]; do [[ ! -L $current ]] || fail 'symlink in owned path'; current=$(dirname -- "$current"); done
}
for own in "$app" "$data" "$runtime" "$site" "$unit" "$webroot"; do check_path "$own"; done
for command in nginx certbot python3 curl tar xz sha256sum ss useradd getent install openssl systemctl; do command -v "$command" >/dev/null || fail 'a required existing system tool is unavailable'; done
[[ $(uname -m) == x86_64 ]] || fail 'this artifact targets Linux x86_64'

if [[ $1 == prepare ]]; then
    staging=$2 commit=$3
    [[ $staging =~ ^/var/tmp/assaynova-demo-[A-Za-z0-9_-]+$ && $commit =~ ^[a-f0-9]{40}$ ]] || fail 'unexpected staging path or commit'
    check_path "$staging"
    for own in "$app" "$data" "$runtime" "$site" "$enabled" "$unit" "$webroot"; do [[ ! -e $own && ! -L $own ]] || fail 'an owned destination already exists; inspect it before any retry'; done
    [[ ! -e /etc/letsencrypt/live/assaynovalabs.com && ! -e /etc/letsencrypt/renewal/assaynovalabs.com.conf ]] || fail 'an unowned certificate lineage already exists'
    getent passwd assaynova-demo >/dev/null && fail 'service account already exists without this installation'
    getent group assaynova-demo >/dev/null && fail 'service group already exists without this installation'
    if ss -ltnH | awk '{print $4}' | grep -Eq '(^|:)4330$'; then fail 'port 4330 is already occupied'; fi
    # Credential is copied opaquely, never parsed, printed, hashed or archived.
    check_path "$staging/credential.json"
    [[ -f $staging/credential.json && ! -L $staging/credential.json && -s $staging/credential.json ]] || fail 'approved opaque credential is required before installation'
    python3 - "$staging" "$commit" <<'PY'
import hashlib,json,os,re,sys
from pathlib import Path
stage=Path(sys.argv[1]); commit=sys.argv[2]
def stop(): raise SystemExit('Release or catalog manifest rejected')
def permitted(name,manifest):
    if manifest=='catalog-manifest.json':
        return name=='store/customers/profiles.json' or re.fullmatch(r'store/customer-imports/revisions/[a-f0-9]{32}/(?:records\.json|catalog\.json|aliases\.json|images/[^/]+\.png)',name) or re.fullmatch(r'images/[a-f0-9]{20}/[^/]+\.png',name)
    prefixes=('dist/','accounts/','conference/','templates/coa/','scripts/','deploy/demo/')
    return (name in ('server.mjs','report-pdf.mjs','package.json') or name.startswith(prefixes)) and not any(p in ('.git','work','plans','dev','tests','docs','node_modules','__pycache__','credential.json','private.json','accounts.sqlite','accounts.sqlite-wal','accounts.sqlite-shm') or p.startswith('.env') for p in name.split('/')) and not name.endswith(('.pem','.key','.pyc'))
def verify(root,manifest):
    if root.is_symlink() or not root.is_dir(): stop()
    if (root/manifest).is_symlink() or not (root/manifest).is_file(): stop()
    data=json.loads((root/manifest).read_text())
    entries=data.get('files'); seen=set()
    if not isinstance(entries,list) or not entries: stop()
    for row in entries:
        name=row.get('path','')
        if not isinstance(name,str) or not name or '\\' in name or name.startswith('/') or any(p in ('','.','..') for p in name.split('/')) or name in seen: stop()
        if not permitted(name,manifest): stop()
        seen.add(name); f=root/name
        if any(p.is_symlink() for p in [f,*f.parents] if p!=root.parent) or not f.is_file(): stop()
        raw=f.read_bytes()
        if len(raw)!=row.get('bytes') or hashlib.sha256(raw).hexdigest().lower()!=str(row.get('sha256','')).lower(): stop()
    actual=set()
    for parent,dirs,files in os.walk(root,followlinks=False):
        for name in dirs+files:
            if (Path(parent)/name).is_symlink(): stop()
        actual.update((Path(parent)/name).relative_to(root).as_posix() for name in files)
    if actual!=seen|{manifest}: stop()
    return data,seen
release,files=verify(stage/'release','release-manifest.json')
if release.get('commit')!=commit: stop()
prefixes=('dist/','accounts/','conference/','templates/coa/','scripts/','deploy/demo/')
if not {'server.mjs','report-pdf.mjs','package.json'}<=files: stop()
for name in files:
    if name not in ('server.mjs','report-pdf.mjs','package.json') and not name.startswith(prefixes): stop()
    if any(p in ('.git','work','plans','dev','tests','docs','node_modules','__pycache__') or p.startswith('.env') for p in name.split('/')) or name.endswith(('.pem','.key','.pyc')): stop()
catalog,files=verify(stage/'catalog','catalog-manifest.json')
if catalog.get('kind')!='assaynova-demo-catalog' or catalog.get('version')!=1 or catalog.get('targetStore')!='/var/lib/assaynova-demo/reports' or catalog.get('targetImages')!='/var/lib/assaynova-demo/seed-images': stop()
for name in files:
    if name=='store/customers/profiles.json': continue
    if re.fullmatch(r'store/customer-imports/revisions/[a-f0-9]{32}/(?:records\.json|catalog\.json|aliases\.json|images/[^/]+\.png)',name): continue
    if re.fullmatch(r'images/[a-f0-9]{20}/[^/]+\.png',name): continue
    stop()
PY
    useradd --system --user-group --home-dir "$data" --no-create-home --shell /usr/sbin/nologin assaynova-demo
    install -d -m 0755 "$app/releases" "$runtime" "$webroot/.well-known/acme-challenge"
    install -d -o assaynova-demo -g assaynova-demo -m 0700 "$data" "$data/accounts" "$data/reports" "$data/admin-auth" "$data/seed-images" "$data/backups"
    release="$app/releases/$commit"
    install -d -m 0755 "$release"
    cp -R -- "$staging/release/." "$release/"
    cp -R -- "$staging/catalog/store/." "$data/reports/"
    if [[ -d $staging/catalog/images ]]; then cp -R -- "$staging/catalog/images/." "$data/seed-images/"; fi
    install -o assaynova-demo -g assaynova-demo -m 0600 "$staging/credential.json" "$data/admin-auth/credential.json"
    python3 - "$release" "$data/reports" "$data/seed-images" "$staging/catalog/catalog-manifest.json" <<'PY'
import hashlib,json,sys
from pathlib import Path
release=Path(sys.argv[1]); reports=Path(sys.argv[2]); images=Path(sys.argv[3])
for manifest,root in [(json.loads((release/'release-manifest.json').read_text()),release),(json.loads(Path(sys.argv[4]).read_text()),None)]:
    for row in manifest['files']:
        name=row['path']; f=root/name if root else (reports/name[6:] if name.startswith('store/') else images/name[7:])
        raw=f.read_bytes()
        if len(raw)!=row['bytes'] or hashlib.sha256(raw).hexdigest().lower()!=row['sha256'].lower(): raise SystemExit('Installed artifact drift')
PY
    chown -R root:root "$release"; find "$release" -type d -exec chmod 0555 {} +; find "$release" -type f -exec chmod 0444 {} +
    chown -R assaynova-demo:assaynova-demo "$data"; find "$data" -type d -exec chmod 0700 {} +; find "$data" -type f -exec chmod 0600 {} +
    archive=node-v24.22.1-linux-x64.tar.xz
    curl --proto '=https' --tlsv1.2 -fsSL "https://nodejs.org/dist/v24.22.1/$archive" -o "$runtime/$archive"
    curl --proto '=https' --tlsv1.2 -fsSL https://nodejs.org/dist/v24.22.1/SHASUMS256.txt -o "$runtime/SHASUMS256.txt"
    (cd "$runtime"; grep -E "^[a-f0-9]{64}  $archive$" SHASUMS256.txt > node.sha256; [[ $(wc -l < node.sha256) == 1 ]]; sha256sum --check --status node.sha256)
    tar -xJf "$runtime/$archive" -C "$runtime"
    mv -- "$runtime/node-v24.22.1-linux-x64" "$runtime/node"
    if ! python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then apt-get install --no-install-recommends -y python3-venv; fi
    python3 -m venv "$runtime/venv"
    "$runtime/venv/bin/python" -m pip --isolated install --index-url https://pypi.org/simple --disable-pip-version-check -r "$release/deploy/demo/requirements.txt"
    "$runtime/venv/bin/python" -B -c 'import PIL,reportlab; assert PIL.__version__=="13.0.0" and reportlab.Version=="4.4.9"'
    chown -R root:root "$runtime"; chmod -R go+rX "$runtime"
    ln -s "$release" "$app/current"
    printf '%s\n' "$marker" > "$app/.managed-demo-v1"
    install -m 0644 "$release/deploy/demo/assaynova.service" "$unit"
    install -m 0644 "$release/deploy/demo/assaynova-http.nginx.conf" "$site"
    ln -s "$site" "$enabled"
    nginx -t
    systemctl daemon-reload
    systemctl enable --now assaynova-demo.service
    ready=false
    for attempt in {1..30}; do if curl -fsS --max-time 3 -H 'Host: assaynovalabs.com' http://127.0.0.1:4330/admin | grep -q 'name="admin-auth-mode" content="login"'; then ready=true; break; fi; sleep 1; done
    [[ $ready == true ]] || fail 'runtime did not confirm the existing administrator credential'
    systemctl reload nginx
    printf '%s\n' 'Prepared: HTTP application routes remain closed (503) until valid HTTPS is enabled.'
else
    [[ -f $app/.managed-demo-v1 && $(cat "$app/.managed-demo-v1") == "$marker" ]] || fail 'managed demo installation is absent'
    [[ -L $app/current && $(readlink "$app/current") =~ ^/srv/assaynova-demo/releases/[a-f0-9]{40}$ ]] || fail 'unexpected current release'
    [[ -L $enabled && $(readlink "$enabled") == "$site" ]] || fail 'unexpected enabled site'
    hook=/etc/letsencrypt/renewal-hooks/deploy/assaynova-demo
    check_path "$hook"; [[ ! -e $hook && -d /etc/letsencrypt/renewal-hooks/deploy ]] || fail 'renewal hook destination is not available'
    grep -q '^# Managed by AssayNova demo installer v1\.' "$site" || fail 'site is not owned by this installer'
    [[ -f $data/admin-auth/credential.json && -s $data/admin-auth/credential.json ]] || fail 'administrator credential is absent'
    systemctl is-active --quiet assaynova-demo.service || fail 'demo service is inactive'
    python3 - <<'PY'
import socket
for host in ('assaynovalabs.com','www.assaynovalabs.com'):
    addresses={r[4][0] for r in socket.getaddrinfo(host,None)}
    if addresses!={'54.144.250.46'}: raise SystemExit('DNS is not ready for the reviewed demo address')
PY
    certbot certonly --non-interactive --webroot --webroot-path "$webroot" --cert-name assaynovalabs.com -d assaynovalabs.com -d www.assaynovalabs.com --agree-tos
    openssl x509 -in /etc/letsencrypt/live/assaynovalabs.com/fullchain.pem -noout -checkend 86400 >/dev/null
    openssl x509 -in /etc/letsencrypt/live/assaynovalabs.com/fullchain.pem -noout -checkhost assaynovalabs.com >/dev/null
    openssl x509 -in /etc/letsencrypt/live/assaynovalabs.com/fullchain.pem -noout -checkhost www.assaynovalabs.com >/dev/null
    backup="$data/backups/nginx-http-$(date -u +%Y%m%dT%H%M%SZ).conf"
    [[ ! -e $backup ]] || fail 'backup destination exists'
    check_path "$backup"
    cp -- "$site" "$backup"; chmod 0600 "$backup"
    install -m 0644 "$app/current/deploy/demo/assaynova-https.nginx.conf" "$site"
    if ! nginx -t; then cp -- "$backup" "$site"; fail 'HTTPS configuration failed validation; previous own site restored'; fi
    cat > "$hook" <<'HOOK'
#!/bin/sh
# Managed by AssayNova demo installer v1.
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/assaynovalabs.com ]; then
    /usr/sbin/nginx -t && /bin/systemctl reload nginx
fi
HOOK
    chmod 0755 "$hook"
    systemctl reload nginx
    printf '%s\n' 'HTTPS enabled for the demo. Run normal certificate-verified public acceptance checks.'
fi
