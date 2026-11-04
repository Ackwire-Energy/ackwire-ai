import type { HelpSlug } from "./index";
import type { HelpDocument } from "./types";

/** The help pages in id: a page not here shows in English. */
export const helpId: Partial<Record<HelpSlug, HelpDocument>> = {
  "run-on-your-computer": {
    title: "Jalankan agentes.chat di komputermu",
    summary:
      "Aplikasi agentes.chat juga bisa menjalankan agentes.chat sendiri, di Mac, PC, atau komputer Linux, untukmu atau tim kecil.",
    sections: [
      {
        id: "how",
        heading: "Cara kerjanya",
        blocks: [
          "agentes.chat berjalan di dalam aplikasi, dengan database bawaannya sendiri, dan menyimpan semuanya di satu folder di komputer ini, `.agentes` di folder pribadimu. Tidak ada lagi yang perlu dipasang: tanpa Docker, tanpa database yang perlu disiapkan.",
          "agentes.chat menyala bersama aplikasi dan berhenti saat kamu menutupnya. Aplikasi bertanya dulu sebelum ditutup, karena tidak ada yang bisa memakai agentes.chat sampai aplikasinya dibuka lagi.",
        ],
      },
      {
        id: "who",
        heading: "Untuk siapa",
        blocks: [
          "Dibuat untukmu atau tim kecil, selama komputer ini menyala. Untuk tim yang lebih besar, atau server yang selalu menyala, pasang agentes.chat di server lalu pilih **Hubungkan ke serverku** di aplikasi. Datamu bisa dipindahkan ke sana nanti.",
        ],
      },
      {
        id: "agents",
        heading: "Agen-agenmu juga bekerja di sini",
        blocks: [
          "Agen-agenmu juga bekerja di komputer ini, di folder mereka sendiri, dengan browser, dan dengan Claude Code atau Codex kalau terpasang di sini. Perintah tetap mati sampai kamu menyalakannya di **Preferensi › Alat**.",
        ],
      },
      {
        id: "reach",
        heading: "Dari ponselmu dan timmu",
        blocks: [
          "**Akses dari ponselmu dan rekan tim** menaruh agentes.chat di Tailscale, jaringan pribadi untuk perangkatmu: ponselmu dan orang yang kamu undang bergabung ke jaringan itu, dan tidak ada orang lain yang bisa menjangkau agentes.chat. Tailscale gratis: https://tailscale.com/download. Kalau dimatikan, agentes.chat hanya bisa dipakai di komputer ini.",
        ],
      },
      {
        id: "backups",
        heading: "Cadangan dan pindahan",
        blocks: [
          "**Cadangkan sekarang**, di **Preferensi › Server**, menyimpan database, file, dan pengaturan di `.agentes/backups`, di folder pribadimu.",
        ],
      },
    ],
  },
  computers: {
    title: "Komputer untuk agen-agenmu",
    summary:
      "Agen menjalankan kode dan mengolah file di komputer yang kamu hubungkan: Mac atau PC dengan aplikasi agentes.chat, atau server.",
    sections: [
      {
        id: "mac",
        heading: "Mac atau PC, dengan aplikasinya",
        blocks: [
          "Aplikasi agentes.chat membuka servermu di jendelanya sendiri, dan dengan satu klik agen-agennya bekerja di komputer itu, di folder mereka sendiri. Pasang aplikasinya, buka, pilih **Pakai servermu sendiri › Hubungkan ke serverku** lalu ketik alamat servermu. Setelah masuk, klik **Pakai Mac ini** (**Pakai PC ini** di Windows, **Pakai komputer ini** di Linux) di **Pengaturan › Komputer**.",
        ],
      },
      {
        id: "server",
        heading: "Server atau komputer Linux",
        blocks: [
          "Di **Pengaturan › Komputer**, salin perintah di bawah **Cara lain** lalu jalankan di terminal komputer itu. Perintah itu menampilkan kode dan tautan: buka tautannya, pastikan kodenya sama, lalu konfirmasi dengan akunmu. Tidak ada yang perlu dipasang lebih dulu.",
        ],
      },
      {
        id: "folders",
        heading: "Folder",
        blocks: [
          "Tiap agen selalu punya foldernya sendiri, di `~/agentes/<workspace>`. Folder lain hanya bisa diizinkan dari komputer itu sendiri, tidak pernah dari situs: di aplikasi, **Preferensi › Folder**, atau dengan `agentes-runner folders allow` di server. Tiap ruang kerja mengizinkan foldernya sendiri: yang kamu izinkan untuk satu ruang kerja hanya berlaku untuk agen-agennya. Menghapus folder dari daftar tidak menghapus apa pun. Itu hanya mencabut aksesnya.",
        ],
      },
      {
        id: "pausing",
        heading: "Menjeda",
        blocks: [
          "Dengan aplikasinya, orang yang menghubungkan komputer bisa menjeda agen-agen di sana, dari ikon agentes.chat di dekat jam. Tidak ada yang baru dimulai sampai mereka melanjutkannya. Yang sedang berjalan tetap diselesaikan.",
        ],
      },
      {
        id: "organizations",
        heading: "Beberapa ruang kerja",
        blocks: [
          "Satu komputer bisa bekerja untuk beberapa ruang kerja. Masing-masing punya agen, folder, dan tugasnya sendiri di sana, dan memutuskan satu ruang kerja tidak memengaruhi yang lain.",
        ],
      },
    ],
  },
  "workspace-computer": {
    title: "Komputer ruang kerja",
    summary: "Tiap ruang kerja mendapat komputernya sendiri, selalu menyala, tempat agen-agennya bekerja.",
    sections: [
      {
        id: "what",
        heading: "Apa itu",
        blocks: [
          "Komputer khusus untuk ruang kerja ini, selalu menyala. Tiap agen punya pengguna sendiri di sana, dengan folder, layar, browser, dan file miliknya. Dari halaman agen kamu bisa melihatnya bekerja, dan mengambil alih saat perlu.",
        ],
      },
      {
        id: "plans",
        heading: "Paket AI kamu",
        blocks: [
          "Agen-agenmu bisa berpikir dengan paket AI milikmu, seperti Claude, ChatGPT, GLM, atau Kimi, yang masuk di komputer ini: tanpa perlu kunci API. Akunnya tetap di komputer ini, dan agentes.chat tidak pernah melihat kata sandi atau aksesnya.",
          "Paket AI Pro dan Ultra dari Google tidak bisa dipakai di sini: ketentuan Google tidak mengizinkannya di produk lain. Kunci API Gemini bisa.",
        ],
      },
      {
        id: "size",
        heading: "Ukurannya",
        blocks: ["CPU, memori, dan disknya terlihat di **Pengaturan › Komputer**."],
      },
      {
        id: "trouble",
        heading: "Kalau tidak merespons",
        blocks: [
          "Biasanya komputer ini kembali dalam beberapa menit, dan kami sedang menanganinya: kamu tidak perlu melakukan apa-apa.",
        ],
      },
    ],
  },
  import: {
    title: "Bawa agen-agenmu",
    summary:
      "Bawa agen dari aplikasi lain, atau dari ruang kerja agentes.chat lain, lengkap dengan instruksi, skill, rutinitas, dan memorinya.",
    sections: [
      {
        id: "comes",
        heading: "Apa yang ikut dibawa",
        blocks: [
          {
            list: [
              "Agen, dengan nama, peran, instruksi, dan tampilannya.",
              "Skill, menyala untuk agen yang memilikinya.",
              "Kanal publik, dengan agen-agen di dalamnya.",
              "Rutinitas, aktif dan sesuai jadwalnya. Jeda di **Rutinitas** kalau kamu mau.",
              "Memori: apa yang diingat tiap agen.",
              "File milik tiap agen (folder files di OpenBot.run, ruang kerja OpenClaw), di folder dengan namanya di **Drive**. Kunci, info masuk, dan file sistem tidak dibawa, dan tidak ada yang sudah ada di sana yang ditimpa.",
            ],
          },
        ],
      },
      {
        id: "never",
        heading: "Apa yang tidak pernah dibawa",
        blocks: [
          "Kunci, kata sandi, info masuk, dan riwayat chat tidak pernah dibawa: agen berpikir dengan AI milik ruang kerja. Beberapa hal belum punya padanan di sini, atau tidak boleh dipindahkan lewat file. Kamu bisa membuatnya lagi nanti.",
          "File dan folder dibaca di browsermu. Tautan GitHub diproses lewat server ruang kerja. File kunci dan info masuk tidak pernah dibuka, dan tidak ada yang berubah sampai kamu mengonfirmasi.",
        ],
      },
      {
        id: "other-apps",
        heading: "Dari aplikasi lain",
        blocks: [
          "Pilih **Grok Bot**, **ChatGPT dots**, atau **Aplikasi lain**. Salin permintaannya, tempel di aplikasi itu, lalu bawa kembali hasilnya: taruh filenya, atau tempel seluruh balasannya. Tempat menaruhnya di tiap aplikasi:",
          {
            list: [
              "**Grok Bot**: di chat dengan bot kamu. Bot membalas dengan JSON: salin seluruh balasannya.",
              "**ChatGPT dots**: di chat baru. Unduh file yang dibuatnya.",
              "**Claude**: di percakapan baru, atau di proyek agen-agenmu. Unduh file yang dibuatnya.",
              "**Manus**: di tugas baru. Filenya ada di hasil tugas.",
              "**Rakazo**: kirim ke agenmu. Agen membalas dengan JSON: salin seluruh balasannya.",
              "**OpenBot**: tidak perlu permintaan. Seret folder tenant (agents.yaml, agents/, model.yaml, skills.yaml) atau tempel tautan GitHub-nya.",
            ],
          },
        ],
      },
      {
        id: "export",
        heading: "Ekspor ruang kerja",
        blocks: [
          "**Pengaturan › Impor dan ekspor › Ekspor** mengunduh file .json, untuk membawa agen-agenmu ke ruang kerja lain atau menyimpan salinannya. Isi filenya:",
          {
            list: [
              "Agen, dengan instruksi, model, dan tampilannya",
              "Skill, dengan SKILL.md lengkap",
              "Kanal publik, dengan agen-agennya",
              "Rutinitas terjadwal (langsung aktif di ruang kerja tujuan)",
              "Memori yang bisa dilihat semua orang di ruang kerja",
            ],
          },
          "Tidak pernah ada di dalamnya:",
          {
            list: [
              "Kunci API dan kata sandi",
              "Konektor dan info masuk",
              "Komputer",
              "Percakapan, pesan, dan kanal privat",
              "Pemakaian, biaya, dan riwayat aktivitas",
            ],
          },
          "Untuk memakai filenya, buka **Pengaturan › Impor dan ekspor** di ruang kerja lain lalu taruh file .json-nya.",
        ],
      },
    ],
  },
  wiki: {
    title: "Wiki",
    summary: "Apa yang diketahui perusahaan, dalam halaman yang saling terhubung.",
    sections: [
      {
        id: "links",
        heading: "Tautan",
        blocks: ["Ketik [[ untuk menautkan halaman lain. Tautan balik dan grafik menunjukkan hubungan antarhalaman."],
      },
      {
        id: "agents",
        heading: "Cara agen memakainya",
        blocks: ["Agen membaca wiki saat menjawab. Mereka hanya menulis di sana kalau ada yang meminta."],
      },
      {
        id: "obsidian",
        heading: "Bawa vault Obsidian",
        blocks: [
          "Taruh folder vault, atau file .zip-nya, di langkah Konteks saat penyiapan atau di impor milik wiki. [[Tautan]], [[note|alias]], dan [[note#section]] tetap berfungsi. Tag diambil dari frontmatter dan teksnya. Lampiran masuk ke Drive, dan gambar serta file yang disematkan menjadi kartu di halaman. Callout tetap menjadi callout. Kueri Dataview masuk sebagai teks: minta agen membuat tabelnya. Canvas dan pengaturan Obsidian (.obsidian) tidak dibawa.",
        ],
      },
    ],
  },
  memory: {
    title: "Memori",
    summary: "Apa yang dipelajari tiap agen dari percakapan dan koreksi tim.",
    sections: [
      {
        id: "learns",
        heading: "Cara agen belajar",
        blocks: [
          "Agen belajar dari percakapan dan dari koreksi tim. Apa yang diketahui agen masuk ke konteksnya saat relevan. Di tab **Memori** miliknya, ubah, sematkan, atau arsipkan yang salah atau sudah usang.",
        ],
      },
      {
        id: "permissions",
        heading: "Memori tidak memberi izin",
        blocks: [
          "Tidak ada isi memori yang membuat agen bisa berbuat lebih. Apa yang bisa dilakukannya tetap diatur di **Alat dan akses**, dan tindakan sensitif selalu meminta persetujuan.",
        ],
      },
      {
        id: "proposals",
        heading: "Usulan perubahan",
        blocks: [
          "Kalau sebuah pelajaran terulang, agen bisa mengusulkan perubahan pada instruksinya sendiri atau pada konteks ruang kerja. Tidak ada yang berubah sampai seseorang menerimanya, dan teksnya bisa disesuaikan dulu. Versi sebelumnya tetap ada di riwayat. Usulan yang ditolak disimpan sebagai pelajaran, jadi tidak diusulkan lagi.",
        ],
      },
    ],
  },
  approvals: {
    title: "Persetujuan",
    summary: "Tidak ada hal sensitif yang terjadi tanpa orang.",
    sections: [
      {
        id: "what",
        heading: "Apa yang meminta izin dulu",
        blocks: [
          "Saat agen ingin melakukan merge, deploy, rollback, mengirim sesuatu ke luar, atau menghapus data, agen meminta izin dulu, apa pun akses yang dimilikinya. Permintaannya muncul di **Persetujuan** dan di kanal, dengan tindakan persisnya dan alasannya.",
        ],
      },
      {
        id: "exact",
        heading: "Satu persetujuan, satu tindakan",
        blocks: [
          "Tiap persetujuan berlaku untuk satu tindakan persis, dengan nilai-nilainya. Kalau agen mengubah apa pun, agen harus meminta lagi.",
        ],
      },
      {
        id: "who",
        heading: "Siapa yang menyetujui",
        blocks: ["Pemilik agen menyetujui permintaannya. Untuk agen tanpa pemilik, admin yang menyetujui."],
      },
      {
        id: "refusing",
        heading: "Menolak",
        blocks: [
          "Sebutkan alasannya kalau kamu mau: agen membacanya, menyesuaikan rencananya, dan menyimpannya sebagai pelajaran.",
        ],
      },
      {
        id: "meetings",
        heading: "Rapat",
        blocks: ["Agen hanya menyarankan waktu. Undangan ke orang selalu dikirim lewat orang yang meminta."],
      },
    ],
  },
  "who-answers": {
    title: "Siapa yang menjawab pesan",
    summary: "Sebutan memilih agennya. Tanpa sebutan, agentes.chat memilihkan untukmu, dengan urutan ini.",
    sections: [
      {
        id: "order",
        heading: "Cara pesan menemukan agennya",
        blocks: [
          "Pesan yang @menyebut agen masuk ke agen itu. Pesan yang tidak menyebut siapa pun dibaca oleh yang pertama dari daftar ini yang dimiliki ruang kerja:",
          {
            list: [
              "**Jev**, model kecil dan cepat yang dibuat untuk keputusan seperti ini.",
              "**Model kecil dengan salah satu kunci API ruang kerja**, seperti Claude Haiku 5.5 atau GPT-6 Luna.",
              "**Paket Claude atau ChatGPT milikmu**, untuk pesan yang kamu tulis, di server yang kamu jalankan sendiri. Paket ini membacanya di komputer tempat paket itu masuk, dan butuh beberapa detik.",
              "**Aturan sederhana**: balasan ke agen masuk ke agen itu, begitu juga pesan lanjutan tepat setelah kamu bicara dengannya, atau pesan di kanal tempat kamu hanya berdua dengan satu agen.",
            ],
          },
          "Kalau tidak ada yang cocok, tidak ada agen yang menjawab. Sebut agen untuk memanggilnya.",
        ],
      },
      {
        id: "jev",
        heading: "Jev",
        blocks: [
          "Saat agentes.chat menjadi host ruang kerjamu, Jev sudah termasuk. Di server yang kamu jalankan sendiri, Jev memakai kunci TypeSafe milik pemilik, sekitar US$ 0,0001 per pesan: [Siapkan Jev](/help/jev#setup).",
        ],
      },
      {
        id: "plans",
        heading: "Kenapa paketmu hanya memilih untuk pesanmu",
        blocks: ["Paket Claude dan ChatGPT bersifat pribadi, jadi paketmu hanya memilih untuk pesan yang kamu tulis."],
      },
      {
        id: "see",
        heading: "Melihat siapa yang memilih",
        blocks: ["Buka tanda centang di bawah pesan. Baris terakhirnya menyebut siapa yang memilih agennya."],
      },
    ],
  },
  jev: {
    title: "Jev",
    summary:
      "Model cepat dari TypeSafe yang membuat keputusan cepat untuk agen-agenmu. Di servermu sendiri sifatnya opsional, dengan kunci milikmu.",
    sections: [
      {
        id: "what",
        heading: "Apa yang dilakukannya",
        blocks: [
          {
            list: [
              "**Memilih siapa yang menjawab.** Pesan yang tidak @menyebut siapa pun masuk ke agen yang tepat dalam waktu kurang dari sedetik, bahkan saat agen-agenmu berpikir dengan paket dan kamu tidak punya kunci API.",
              "**Merapikan memori.** Jev mengenali pengulangan atau fakta yang lebih baru meski dengan kata-kata lain: pengulangan digabung dengan yang sudah diketahui agen, dan fakta yang lebih baru menggantikan yang lama. Sekali sehari Jev merapikan sisanya.",
              "**Melihat layar.** Di browser dan desktop mereka, agen menemukan tombol dan kolom dari deskripsi, melihat lebih dekat yang kecil, dan memeriksa di gambar layar bahwa sebuah langkah berhasil.",
              "**Membaca lebih sedikit.** Tiap giliran hanya memuat alat yang kemungkinan dibutuhkan agen, jadi AI kamu membaca lebih sedikit dan biayanya lebih rendah.",
            ],
          },
        ],
      },
      {
        id: "without",
        heading: "Tanpa Jev",
        blocks: [
          "Semuanya tetap berjalan, lebih lambat dan kurang teliti.",
          {
            list: [
              "**Siapa yang menjawab:** model kecil dengan salah satu kunci API kamu yang memilih, seperti Claude Haiku 5.5 atau GPT-6 Luna. Tanpa kunci, paket Claude atau ChatGPT milik tiap orang memilih untuk pesan yang ditulisnya, dalam beberapa detik. Kalau tidak, balasan atau pesan lanjutan tetap sampai ke agennya. Sebut agen untuk memanggilnya. [Cara agen dipilih](/help/who-answers)",
              "**Memori:** pengulangan dengan kata-kata yang sama tetap digabung. Pengulangan dan pembaruan dengan kata-kata lain tetap terpisah.",
              "**Layar:** agen memakai angka yang tampil di layar dan nama persisnya. Tidak ada yang dibaca dari gambar.",
            ],
          },
        ],
      },
      {
        id: "setup",
        heading: "Siapkan Jev",
        blocks: [
          {
            list: [
              "Buka https://console.typesafe.ai lalu masuk dengan Google atau emailmu. Akun baru dibuat dengan cara yang sama.",
              "Tambahkan saldo di konsol. Jev memakai sistem prabayar.",
              "Buka https://console.typesafe.ai/keys, buat kunci, lalu langsung salin.",
              "Di agentes.chat, buka **Pengaturan › Akun AI** lalu tempel di bawah **Jev**. Hanya orang yang menyiapkan server ini yang bisa melihatnya.",
            ],
          },
          "Di server yang kamu jalankan dengan Docker, kamu juga bisa menaruh kuncinya di `.env` sebagai `TYPESAFE_API_KEY`. Kunci itu lebih diutamakan daripada yang ada di Pengaturan.",
        ],
      },
      {
        id: "cost",
        heading: "Biayanya",
        blocks: [
          {
            list: [
              "US$ 0,042 per sejuta token yang dibaca Jev. Jawabannya gratis. Memilih siapa yang menjawab membaca sekitar 2.500 token, jadi sekitar US$ 0,0001. Satu tangkapan layar sekitar 3.900 token.",
              "Saldo yang kamu beli berlaku 12 bulan. Nyalakan isi ulang otomatis di konsol supaya saldo Jev tidak habis.",
              "**Pengaturan › Akun AI** menampilkan berapa banyak keputusan yang dibuat Jev bulan ini, dan biayanya.",
            ],
          },
        ],
      },
      {
        id: "data",
        heading: "Datamu",
        blocks: [
          "Yang dibaca Jev untuk memutuskan:",
          {
            list: [
              "Nama dan deskripsi kanal, pesannya, dan beberapa pesan sebelumnya",
              "Nama dan peran agen-agenmu, awal instruksinya, dan alat yang bisa mereka pakai",
              "Butir memori yang dibandingkannya",
              "Tugas agen dan awal hasil alatnya",
              "Tujuan misi dan perintah yang ingin dijalankan agen untuk misi itu",
              "Alat yang ditawarkan aplikasi yang terhubung",
              "Halaman atau layar yang sedang dipakai agen, termasuk tangkapan layar",
            ],
          },
          "TypeSafe menjalankan Jev di Amerika Serikat dan tidak melatih modelnya dengan apa yang kamu kirim. TypeSafe menyimpan data selama dibutuhkan untuk menjalankan layanannya. Retensi nol tersedia di paket enterprise-nya.",
          "Kebijakan privasi TypeSafe: https://typesafe.ai/legal/privacy-policy. Perjanjian pemrosesan datanya: https://typesafe.ai/legal/data-processing.",
        ],
      },
      {
        id: "problems",
        heading: "Saat Jev berhenti",
        blocks: [
          {
            list: [
              "**Kunci tidak diterima:** buat kunci baru lalu tempel di **Pengaturan › Akun AI**.",
              "**Saldo habis:** tambahkan saldo di konsol. Jev mencoba lagi dalam 30 menit, atau klik **Periksa lagi**.",
              "**Sibuk atau tidak bisa dijangkau:** TypeSafe bisa membatasi permintaan per detik, atau berhenti menjawab sementara. Jev akan lanjut lagi dengan sendirinya. Batasmu: https://console.typesafe.ai/rate-limits. Untuk batas yang lebih tinggi, kirim email ke sales@typesafe.ai.",
            ],
          },
          "Sementara itu, agen bekerja seperti di [Tanpa Jev](/help/jev#without).",
        ],
      },
    ],
  },
  "apps-de-ia": {
    title: "Aplikasi AI",
    summary:
      "Minta tugas ke agen-agen agentes.chat dari Claude, Cursor, atau aplikasi MCP lain, tanpa meninggalkannya, dan dapatkan jawabannya di sana.",
    sections: [
      {
        id: "what",
        heading: "Cara kerjanya",
        blocks: [
          "agentes.chat adalah server MCP. Kamu menempel alamatnya di aplikasi AI kamu, masuk dengan akunmu, dan memilih ruang kerja. Sejak itu, aplikasinya bisa melihat daftar agen dan kanal, mengirim tugas ke agen atas namamu, menunggu balasannya, dan membaca tugas terbaru.",
          'Misalnya, di tengah mengerjakan adegan di Unity atau Blender, minta ke Claude: "Minta agen marketing membuat teks peluncuran". Pesannya muncul di agentes.chat sebagai pesanmu, bertanda **via Claude**, dan balasan agennya kembali ke Claude.',
          "Alamatnya ada di **Pengaturan › Aplikasi AI**. Alamat itu diakhiri `/mcp`.",
        ],
      },
      {
        id: "connect",
        heading: "Hubungkan aplikasi",
        blocks: [
          {
            list: [
              "**Claude** (claude.ai, Claude Desktop, dan ponsel): di **Sesuaikan › Konektor**, klik **+ Tambah**, lalu **Tambahkan konektor kustom**, beri nama agentes.chat, tempel alamatnya, lalu klik **Lanjutkan**. Pilih **Masuk sekarang**, klik **Tambah**, lalu beri izin. Di paket Team dan Enterprise, Pemilik organisasi Claude menambahkan konektornya di Pengaturan organisasi › Konektor, dan tiap orang mengklik **Hubungkan** di Sesuaikan › Konektor. Paket gratis Claude punya tempat untuk satu konektor kustom.",
              "**Claude Code:** jalankan `claude mcp add --transport http --scope user agentes <address>`, lalu ketik `/mcp`, pilih agentes dan **Authenticate**. Untuk folder saat ini saja, hapus `--scope user`.",
              "**Cursor:** **Tambahkan ke Cursor** di **Pengaturan › Aplikasi AI**, atau tulis alamatnya di `~/.cursor/mcp.json`. Cursor memintamu masuk saat pertama kali dipakai.",
              '**VS Code:** **Tambahkan ke VS Code**, atau tulis alamatnya di `.vscode/mcp.json` dengan `"type": "http"`.',
              "**Aplikasi lain:** ChatGPT, Gemini, Grok, Perplexity, Codex, Zed, JetBrains, dan lainnya punya langkah masing-masing di **Hubungkan aplikasi**, dengan alamatmu sudah terisi.",
            ],
          },
          "Saat kamu masuk, agentes.chat menampilkan aplikasi mana yang meminta akses dan ke mana aplikasi itu kembali. Lanjutkan hanya kalau kamu baru saja memulai koneksinya.",
        ],
      },
      {
        id: "tools",
        heading: "Apa yang bisa dilakukan aplikasi",
        blocks: [
          {
            list: [
              "`send_to_agent`: mengirim pesan darimu ke agen, di percakapan pribadimu dengannya atau di kanal, lalu menunggu balasannya. Hanya dengan akses **Membaca dan mengirim tugas ke agen**.",
              "`wait_for_reply`: terus menunggu balasan sebuah tugas.",
              "`list_agents`: agen yang bisa kamu lihat.",
              "`list_channels`: kanal yang bisa kamu baca.",
              "`read_conversation`: pesan terbaru di kanal, utas, atau tugas.",
              "`list_recent_tasks`: tugas yang kamu kirim dari aplikasi dan apa yang sedang dikerjakan agen.",
            ],
          },
          "Aplikasi bertindak atas namamu dan hanya melihat apa yang kamu lihat. Aplikasi tidak pernah menyetujui tindakan agen: saat agen berhenti untuk meminta persetujuan, balasannya memberi tahu hal itu dengan tautan, dan orang yang memutuskan di agentes.chat. Aplikasi juga tidak mengubah pengaturan, anggota, atau izin.",
        ],
      },
      {
        id: "workspace",
        heading: "Satu ruang kerja per koneksi",
        blocks: [
          "Tiap koneksi berlaku untuk ruang kerja yang dipilih saat masuk. Untuk memakai ruang kerja lain, hubungkan aplikasinya lagi lalu pilih ruang kerja itu.",
          "Di **Pengaturan › Aplikasi AI** kamu bisa melihat aplikasi yang terhubung, kapan masing-masing terakhir dipakai, dan memutuskan mana saja. Orang yang mengelola anggota bisa melihat aplikasi seluruh ruang kerja dan juga bisa memutuskannya. Tiap pesan yang dikirim dari aplikasi muncul di Audit.",
        ],
      },
      {
        id: "tokens",
        heading: "Token pribadi",
        blocks: [
          "Untuk skrip dan aplikasi tanpa masuk lewat OAuth, buat token pribadi di **Pengaturan › Aplikasi AI** lalu kirim di header `Authorization: Bearer`. Token hanya ditampilkan sekali, hanya berlaku di ruang kerja tempat token itu dibuat, dan bisa kedaluwarsa dalam 30 hari, 90 hari, 1 tahun, atau tidak pernah.",
          "Di server tanpa https, dari luar komputernya sendiri, pakai token pribadi: masuk lewat OAuth butuh https.",
        ],
      },
      {
        id: "limits",
        heading: "Batas",
        blocks: [
          {
            list: [
              "Hingga 120 permintaan per menit dan 5.000 per hari untuk tiap koneksi.",
              "Hingga 20 pesan per menit dan 500 per hari untuk tiap orang di tiap ruang kerja.",
              "Satu kali menunggu berlangsung hingga 45 detik. Kalau agen masih bekerja, aplikasinya menunggu lagi.",
            ],
          },
        ],
      },
      {
        id: "safety",
        heading: "Teks dari orang lain",
        blocks: [
          "Balasan berisi teks yang ditulis agen dan orang di agentes.chat. Aplikasi menerima teks itu bertanda sebagai konten, bukan instruksi, tetapi sebuah teks tetap bisa mencoba membujuk aplikasi melakukan hal lain. Periksa apa yang akan dilakukan aplikasimu sebelum kamu mengonfirmasi.",
        ],
      },
      {
        id: "problems",
        heading: "Kalau tidak mau terhubung",
        blocks: [
          {
            list: [
              "**Permintaan kedaluwarsa:** halaman masuk berlaku 30 menit dan hanya bisa dipakai sekali. Kembali ke aplikasi lalu hubungkan lagi.",
              "**Aplikasi meminta masuk lagi:** koneksinya diputus, kata sandinya diganti, atau kamu keluar dari ruang kerja. Masuk lagi dari aplikasi.",
              "**Cursor tertahan di info masuk lama:** tutup Cursor, hapus folder `~/.mcp-auth`, lalu hubungkan lagi.",
            ],
          },
        ],
      },
    ],
  },
};
