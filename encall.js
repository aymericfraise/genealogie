// Encrypts every database in "Mes généalogies" with one password -> <name>.enc next to this script
// usage: node encall.js PASSWORD
const fs = require("fs"), path = require("path")
const dir = path.join(__dirname, "Mes généalogies")
for (const gwa of fs.readdirSync(dir).filter(f => f.endsWith(".gwa"))) {
  const adb = path.join(dir, gwa, gwa.replace(/\.gwa$/, ".adb"))
  console.log(gwa)
  require("child_process").execFileSync("node", [path.join(__dirname, "adb2json.js"), adb, process.argv[2]], { cwd: __dirname, stdio: "inherit" })
}
