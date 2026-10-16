// Généatique database (.adb, Accuracer "ACR5" format) -> people.json
// usage: node adb2json.js "Mes généalogies/fraise.gwa/fraise.adb"            -> writes people.json
//        node adb2json.js "Mes généalogies/fraise.gwa/fraise.adb" PASSWORD   -> writes people.enc (encrypted)
//
// File = 4096-byte pages. Each table page starts with "ACSP", then table id (u32 @8), page type (u32 @16).
// Type 12 = rows: slot bitmap @20 (1 bit per row, 1 = free), then fixed-size rows.
//   Each row starts with a null bitmap (1 bit per field), then fields in schema order.
//   int = 4 bytes, char = 1, strings and blobs = 6-byte ref (u32 page + u16 slot) to a type 10 page.
// Type 10 = blobs: entries from @21 as [u32 marker][u64 len][u64 len][data],
//   and a directory at the page end of [u16 size][u16 slot+1] records, in entry order (size 0 = deleted).
// Type 14 = table schema (field names in UTF-16).
const b = require("fs").readFileSync(process.argv[2])
const db = process.argv[2].replace(/.*[\\/]/, "").replace(".adb", "")

const base = b.indexOf("ACSP")
const pages = []
for (let p = base; p + 4096 <= b.length; p += 4096) if (b.toString("latin1", p, p + 4) == "ACSP") pages.push(p)

function tableId(field) { // id of the table whose schema page contains this field name
  const name = Buffer.from(field, "utf16le")
  const p = pages.find(p => b.readUInt32LE(p + 16) == 14 && b.subarray(p, p + 4096).includes(name))
  return b.readUInt32LE(p + 8)
}

function rows(field, size) {
  const id = tableId(field)
  let n = 200
  while (21 + Math.ceil(n / 8) + n * size > 4096) n--
  const out = []
  for (const p of pages) {
    if (b.readUInt32LE(p + 8) != id || b.readUInt32LE(p + 16) != 12) continue
    for (let r = 0; r < n; r++) {
      if ((b[p + 20 + (r >> 3)] >> (r & 7)) & 1) continue
      const row = b.subarray(p + 21 + Math.ceil(n / 8) + r * size, p + 21 + Math.ceil(n / 8) + (r + 1) * size)
      if (row.some(c => c)) out.push(row)
    }
  }
  return out
}

const isNull = (row, field) => (row[field >> 3] >> (field & 7)) & 1

const blobPages = {}
function blobPage(n) {
  const p = base + n * 4096
  const entries = []
  let o = p + 21
  while (o + 20 <= p + 4096) {
    const marker = b.readUInt32LE(o), len = Number(b.readBigUInt64LE(o + 4))
    if ((marker != 0xffffffff && marker != 0) || !len || o + 20 + len > p + 4096) break
    entries.push(b.subarray(o + 20, o + 20 + len))
    o += 20 + len
  }
  // match entries to the end-of-page directory; stale entries may trail after the real ones, so drop up to 5
  for (let drop = 0; drop < 6; drop++) {
    const slots = {}
    let k = entries.length - 1 - drop, q = p + 4096, ok = true
    while (k >= 0) {
      q -= 4
      const size = b.readUInt16LE(q)
      if (!size) continue
      if (size != entries[k].length + 20) { ok = false; break }
      slots[b.readUInt16LE(q + 2) - 1] = entries[k--]
    }
    if (ok) return slots
  }
  return {}
}
function blob(row, at) {
  const n = row.readUInt32LE(at), slot = row.readUInt16LE(at + 4)
  blobPages[n] = blobPages[n] || blobPage(n)
  return blobPages[n][slot] || Buffer.alloc(0)
}
const wide = (row, at) => blob(row, at).toString("utf16le").replace(/\0+$/, "").trim()
const ansi = (row, at) => blob(row, at).toString("latin1").replace(/\0+$/, "").trim()

// Lieux: null bitmap(1) ID(8) FicheSupprimee(1) Chn1..Chn4(6 each)
const places = {}
for (const r of rows("Chn1", 34)) places[r.readUInt32LE(1)] = { name: [2, 3, 4, 5].filter(f => !isNull(r, f)).map(f => wide(r, 10 + (f - 2) * 6)).filter(s => s).join(", ") }

// Geolocalisation: null bitmap(1) ID_Lieu(4) Lieu_Dit(6) Latitude(8) Longitude(8) Status(4) CurrentAddress(6)
for (const r of rows("Latitude", 37)) {
  const place = places[r.readUInt32LE(1)]
  if (place && !isNull(r, 2)) { place.lat = r.readDoubleLE(11); place.lon = r.readDoubleLE(19) }
}

// other places: match against French communes (communes.json from geo.api.gouv.fr) by code (INSEE or postal) and/or name
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\bst\b/g, "saint").replace(/\bste\b/g, "sainte").replace(/[^a-z0-9]/g, "")
const communes = JSON.parse(require("fs").readFileSync(__dirname + "/communes.json"))
for (const place of Object.values(places)) {
  if (place.lat != null) continue
  const parts = place.name.split(/\s*,\s*/)
  const code = parts.find(s => /^\d[\dAB]\d{3}$/.test(s)) // INSEE or postal code
  const dept = (parts.find(s => /^\d\d(\.\.\.)?$/.test(s)) || "").slice(0, 2) // "51" or "51..."
  const inCode = c => code ? c.code == code || c.codesPostaux.includes(code) : dept ? c.code.startsWith(dept) : true
  let match = null
  for (const part of parts.slice(0, 2)) { // commune is part 1, or part 2 when part 1 is a hamlet
    const found = communes.filter(c => norm(c.nom) == norm(part) && inCode(c))
    if (found.length == 1 || (found.length && (code || dept))) { match = found[0]; break }
  }
  if (!match && code) match = communes.find(inCode) // no name match: first commune with that code
  if (match) { place.lon = match.centre.coordinates[0]; place.lat = match.centre.coordinates[1] }
}

// Personnes: null bitmap(2) ID(4) TypePersonne(1) FicheSupprimee(1) Sexe(1) Pere(4) Mere(4) Data(6) Nom(6) Prenoms(6) OrdrePU(1) Note(4) NbEnf(2) NbConj(2)
const people = {}
for (const r of rows("Prenoms", 44)) {
  const id = r.readUInt32LE(2)
  if (!id || r[7] == 0x4f) continue // 'O' = FicheSupprimee
  people[id] = {
    id: db + ":" + id,
    name: [wide(r, 29), wide(r, 23)].filter(s => s).join(" "),
    sex: String.fromCharCode(r[8]).trim(),
    father: r.readUInt32LE(9), mother: r.readUInt32LE(13),
    birth: null, death: null, occupation: null, unions: [], places: [],
  }
}

// Evenements: null bitmap(3) ID(4) Type(1) LibelleChamps(6) Donnee(6) NoPersA(4) NoPersB(4) Acte(4) TypeCalend(2) Date(11)
//   Lieu(4) LieuDit(6) Note(4) NoIllustrationParDefaut(4) LienExtEven(4) _DONNEE(6) _DATE(4) RANG_A(4) RANG_B(4) DateLastModif(8)
for (const r of rows("LibelleChamps", 93)) {
  const kind = ansi(r, 8), a = people[r.readUInt32LE(20)], bb = people[r.readUInt32LE(24)]
  if (!a) continue
  const place = isNull(r, 9) ? null : places[r.readUInt32LE(45)]
  const e = {
    date: isNull(r, 8) ? null : r.toString("latin1", 34, 44).replace(/\0.*/, "").trim(),
    year: isNull(r, 15) ? null : Math.floor(r.readUInt32LE(73) / 10000) || null,
    place: place ? place.name : null, lat: place ? place.lat : null, lon: place ? place.lon : null,
  }
  if (kind == "NAISSANCE" || (kind == "BAPTEME" && !a.birth)) a.birth = e
  if (kind == "DECES" || (kind == "INHUMATION" && !a.death)) a.death = e
  if (kind == "PROFESSION" && !isNull(r, 3)) a.occupation = [a.occupation, wide(r, 14)].filter(s => s).join(", ")
  if (kind == "UNION" && bb) { a.unions.push({ spouse: bb.id, ...e }); bb.unions.push({ spouse: a.id, ...e }) }
  if (e.lat != null) { a.places.push({ kind, ...e }); if (bb) bb.places.push({ kind, ...e }) }
}

for (const p of Object.values(people)) {
  p.father = people[p.father] ? people[p.father].id : null
  p.mother = people[p.mother] ? people[p.mother].id : null
}
const json = JSON.stringify(Object.values(people))
const password = process.argv[3]
if (!password) require("fs").writeFileSync("people.json", json)
else { // PBKDF2-SHA256 -> AES-256-GCM, file = salt(16) iv(12) ciphertext tag(16), decrypted by index.html
  const crypto = require("crypto")
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", crypto.pbkdf2Sync(password, salt, 200000, 32, "sha256"), iv)
  require("fs").writeFileSync("people.enc", Buffer.concat([salt, iv, cipher.update(json), cipher.final(), cipher.getAuthTag()]))
}
