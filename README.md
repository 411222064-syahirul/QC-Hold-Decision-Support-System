# Panduan Lengkap Instalasi & Setup Aplikasi QC System

Sebelum memulai, pastikan komputer Anda telah terinstal beberapa software berikut:

1. **Python** (Versi 3.8 atau yang lebih baru) - pastikan saat instalasi Anda mencentang opsi `"Add Python to PATH"`.
2. **MySQL Server** (Atau bisa juga menggunakan XAMPP/WAMP untuk kemudahan).
3. **Git** (Opsional, jika Anda melakukan _clone_ repository).

---

## Langkah-Langkah Setup

### 1. Download / Clone Repository

Jika menggunakan Git, jalankan perintah berikut di terminal/Command Prompt Anda:

```bash
git clone <url-repo-github>
cd c45
```

Atau jika Anda mengunduh berformat `.zip`, cukup ekstrak file tersebut dan buka terminal di dalam folder hasil ekstraknya.

### 2. Membuat File Environment / Konfigurasi

Aplikasi Flask ini membutuhkan file konfigurasi keamanan dan database yang disembunyikan (_ignored_ oleh Git). User harus membuat konfigurasinya secara manual:

1. Copy file `.env.example` lalu ubah namanya (rename) menjadi `.env`.
   - Di terminal (Linux/Mac): `cp .env.example .env`
   - Di Windows CMD: `copy .env.example .env`
2. Buka file `.env` tersebut dengan Text Editor (seperti Notepad/VS Code) dan sesuaikan pengaturannya, terutama di bagian `DB_USER` dan `DB_PASSWORD`.
   _Catatan: Jika Anda menggunakan XAMPP default, biarkan `DB_USER=root` dan `DB_PASSWORD=` (kosongkan)._

### 3. Menginstal Dependensi Python (Libraries)

Aplikasi membutuhkan beberapa _library_ Python tambahan (seperti Flask, Pandas, openpyxl, dll) agar bisa berjalan.
Pada terminal, ketikkan perintah berikut (pastikan koneksi internet stabil):

```bash
pip install -r requirements.txt
```

### 4. Menyiapkan Database

Aplikasi ini sudah dilengkapi dengan struktur tabel awal dan data bawaan (_seed data_) seperti akun login Admin dan Master Data awal.

**Cara 1: Menggunakan Command Line (Terminal)**
Pastikan MySQL sudah berjalan, lalu buat databasenya:

```bash
# Masuk ke MySQL shell
mysql -u root -p
```

```sql
CREATE DATABASE qc_system;
EXIT;
```

Lalu, masukkan (_import_) skema awal ke dalam database yang baru dibuat:

```bash
mysql -u root -p qc_system < migrations/0001_init.sql
```

**Cara 2: Menggunakan phpMyAdmin (XAMPP)**

1. Buka browser dan akses `http://localhost/phpmyadmin`
2. Buat database baru dengan nama `qc_system`.
3. Klik pada database tersebut, lalu pilih menu **Import** di bagian atas.
4. Klik tombol **Choose File**, arahkan ke folder `migrations` pada aplikasi ini, dan pilih file `0001_init.sql`.
5. Scroll ke bawah dan klik tombol **Go** atau **Import**.

### 5. Menjalankan Aplikasi Web

Setelah konfigurasi dan database selesai dibuat, aplikasi sudah bisa dijalankan. Di terminal User, ketikkan:

```bash
python main.py
```

Aplikasi akan mulai berjalan. Akan muncul teks seperti `Running on http://127.0.0.1:5000`.

---

## Mengakses Aplikasi

Buka Browser pilihan (Chrome/Firefox/Edge) dan ketikkan alamat:
**http://localhost:5000**

**Login Default Bawaan:**

- **Username:** `admin`
- **Password:** `admin@123`

Setelah berhasil login, bisa membuat pengguna (User) tambahan, mengatur Master Data, dan melakukan Manajemen QC Hold!

> **PENTING:** Jika ada fitur yang terasa error terkait _Import Excel_, pastikan Anda benar-benar telah menjalankan _step_ nomor 3 (`pip install -r requirements.txt`) sehingga _library_ seperti `pandas` dan `openpyxl` terinstal dengan benar.
# QC-Hold-Decision-Support-System
