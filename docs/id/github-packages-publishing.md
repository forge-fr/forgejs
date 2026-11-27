# Panduan Hosting & Publikasi Package npm ForgeJS di GitHub

Semua 20 paket `@forge-fr/*` di monorepo ini (`v1.0.0-rc.2`, Pure ESM + deklarasi TypeScript `.d.ts`) sudah disiapkan untuk di-host dan dipublikasikan melalui **GitHub Packages (`https://npm.pkg.github.com`)** serta **GitHub Releases** (arsip `.tgz` + checksum SHA-256).

---

## 1. File & Skrip yang Sudah Disiapkan

| File / Skrip | Fungsi |
| :--- | :--- |
| `.github/workflows/github-packages.yml` | Workflow GitHub Actions otomatis untuk build, verifikasi tarball, publish ke `https://npm.pkg.github.com`, dan melampirkan 20 file `.tgz` ke GitHub Release. |
| `scripts/prepare-github-packages.mjs` | Skrip Node.js untuk build 20 paket, verifikasi consumer (NodeNext + Bundler), re-scope `@owner/*`, packing `.tgz` + `SHA256SUMS.txt`, dan publikasi berurutan secara topologi. |
| `.npmrc.github.example` | Template konfigurasi `.npmrc` untuk mengautentikasi registry GitHub Packages secara aman tanpa menyimpan token di Git. |
| `.gitignore` | Memastikan `.npmrc` lokal dan folder output `dist-packages/` tidak ikut ter-commit ke repositori. |
| `package.json` (root) | Menambahkan perintah siap pakai: `packages:build`, `packages:verify`, `packages:prepare:github`, dan `packages:publish:github`. |

---

## 2. Aturan Penting Scope GitHub Packages (`@owner/*`)

Registry GitHub Packages (`https://npm.pkg.github.com`) **mewajibkan scope npm (`@owner`) sama persis dengan pemilik repositori GitHub** (username atau nama organisasi dalam huruf kecil) serta `repository.url` mengarah ke repo tersebut:

- **Jika repo di-host di organisasi `github.com/forgejs/forgejs`:** tidak perlu mengubah manifest sama sekali; semua paket langsung terpublikasi sebagai `@forge-fr/*`.
- **Jika repo di-host di akun GitHub pribadi/organisasi lain (mis. `github.com/username-anda/forgejs`):**
  - Saat menggunakan **GitHub Actions (`.github/workflows/github-packages.yml`)**, workflow sudah **otomatis** menyesuaikan scope ke `@<username-anda>/*` di runner CI sebelum packing dan publish.
  - Jika ingin mengubah scope secara permanen di repo lokal sebelum push atau publish manual, jalankan:
    ```bash
    # Simulasi (preview perubahan saja)
    node scripts/prepare-github-packages.mjs --owner username-anda --repo nama-repo

    # Terapkan ke semua 20 packages/*/package.json & .npmrc.github.example
    node scripts/prepare-github-packages.mjs --owner username-anda --repo nama-repo --apply
    ```

---

## 3. Verifikasi Lokal Sebelum Publikasi

Pastikan seluruh build, deklarasi TypeScript, tarball `.tgz`, dan checksum bersih:

```bash
npm run packages:prepare:github
```

Perintah di atas otomatis menjalankan:
1. `tsc -b --force` pada seluruh 20 paket (`packages/*/tsconfig.json`).
2. `scripts/verify-packaging.mjs` (uji instalasi tarball terisolasi untuk `NodeNext` & `Bundler`, serta smoke test di Node.js dan Bun).
3. Pembuatan bundel siap unggah di folder `dist-packages/` berisi 20 file `.tgz`, `SHA256SUMS.txt`, dan `release-manifest.json`.

---

## 4. Cara Publikasi ke GitHub Packages

### Opsi A — Otomatis via GitHub Actions (Direkomendasikan)

Metode ini memakai `GITHUB_TOKEN` bawaan GitHub Actions (`permissions: packages: write`, `contents: write`), sehingga Anda **tidak perlu membuat token/secret npm tambahan**.

1. Push repositori ini ke GitHub (`main` branch).
2. Di GitHub, buka **Settings → Actions → General → Workflow permissions**, pastikan **Read and write permissions** diaktifkan.
3. **Publikasi manual langsung dari GitHub:**
   - Buka tab **Actions → Publish to GitHub Packages → Run workflow**.
   - Pilih `dist_tag`: `next` (untuk `1.0.0-rc.2`) atau `latest` (untuk rilis stabil `1.0.0`).
   - Biarkan `dry_run` **tidak dicentang** (`false`) untuk langsung publish sungguhan (centang `dry_run` hanya jika ingin simulasi tanpa mengunggah paket).
4. **Cek hasil & tautkan paket di halaman repo organisasi:**
   - Setelah job **Publish to npm.pkg.github.com** selesai, cek ringkasan job (**Summary**) untuk memastikan mode adalah `LIVE PUBLISH`.
   - Jika paket sudah muncul di `https://github.com/orgs/<org>/packages` tetapi belum tampil di sidebar **Packages** halaman repositori, buka paket tersebut → **Package settings** → **Connect repository** → pilih repositori target (mis. `forge-fr/forgejs`), lalu atur visibility menjadi **Public** bila diinginkan.
5. **Publikasi otomatis + GitHub Release via tag SemVer:**
   ```bash
   git tag v1.0.0-rc.2
   git push origin v1.0.0-rc.2
   ```
   Workflow akan otomatis:
   - Memverifikasi semua 20 paket.
   - Mempublikasikan seluruh paket dalam urutan topologi (`core` → `router` → `http` → … → `cli`) ke `https://npm.pkg.github.com`.
   - Membuat **GitHub Release** `v1.0.0-rc.2` lengkap dengan 20 file `.tgz`, `SHA256SUMS.txt`, dan `release-manifest.json`.

---

### Opsi B — Publikasi Manual dari Terminal Lokal

1. Buat **GitHub Personal Access Token (Classic)** di GitHub **Settings → Developer settings → Personal access tokens → Tokens (classic)** dengan izin:
   - `write:packages`
   - `read:packages`
   - `repo` (jika repositori bersifat private)
2. Salin template konfigurasi `.npmrc` dan ekspor token Anda:
   ```bash
   cp .npmrc.github.example .npmrc
   export NODE_AUTH_TOKEN=ghp_token_anda_disini
   ```
   *(Jika memakai akun selain `forgejs`, pastikan baris scope di `.npmrc` memakai `@username-anda:registry=https://npm.pkg.github.com`.)*
3. Jalankan uji coba `--dry-run` terlebih dahulu:
   ```bash
   node scripts/prepare-github-packages.mjs --build --publish --tag next --dry-run
   ```
4. Jika seluruh 20 paket lulus dry-run, jalankan publikasi live:
   ```bash
   node scripts/prepare-github-packages.mjs --build --publish --tag next
   ```

> **Catatan:** Skrip secara eksplisit mengirim `--provenance=false` saat publish ke `https://npm.pkg.github.com`, karena fitur `--provenance` Sigstore hanya berlaku untuk registry publik `registry.npmjs.org`.

---

## 5. Cara Menginstal Paket yang Sudah Di-host di GitHub

### Dari GitHub Packages Registry

Di proyek konsumen, tambahkan `.npmrc`:

```ini
@forge-fr:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Lalu instal seperti paket npm biasa:

```bash
npm install @forge-fr/core @forge-fr/http @forge-fr/node
```

### Dari GitHub Releases (`.tgz` Langsung Tanpa Token untuk Repo Publik)

Jika repositori GitHub bersifat publik, file `.tgz` yang dilampirkan di GitHub Release dapat diinstal langsung per paket:

```bash
npm install https://github.com/forge-fr/forgejs/releases/download/v1.0.0-rc.2/forgejs-core-1.0.0-rc.2.tgz
```
