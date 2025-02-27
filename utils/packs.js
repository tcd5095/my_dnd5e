const parsedArgs = require("yargs").argv;

const Datastore = require("nedb");
const fs = require("fs");
const gulp = require("gulp");
const mergeStream = require("merge-stream");
const path = require("path");
const through2 = require("through2");


/**
 * Folder where the compiled compendium packs should be located relative to the
 * base 5e system folder.
 * @type {string}
 */
const PACK_DEST = "packs";

/**
 * Folder where source JSON files should be located relative to the 5e system folder.
 * @type {string}
 */
const PACK_SRC = "packs/src";

/**
 * Cache of DBs so they aren't loaded repeatedly when determining IDs.
 * @type {Object.<string,Datastore>}
 */
const DB_CACHE = {};


/* ----------------------------------------- */
/*  Clean Packs
/* ----------------------------------------- */

/**
 * Removes unwanted flags, permissions, and other data from entries before extracting or compiling.
 * @param {object} data  Data for a single entry to clean.
 * @param {object} [options]
 * @param {boolean} [clearSourceId]  Should the core sourceId flag be deleted.
 */
function cleanPackEntry(data, { clearSourceId=true }={}) {
  if ( data.permission ) data.permission = { "default": 0 };
  if ( clearSourceId ) delete data.flags?.core?.sourceId;
  delete data.flags?.importSource;
  delete data.flags?.exportSource;

  // Remove empty entries in flags
  if ( !data.flags ) data.flags = {};
  Object.entries(data.flags).forEach(([key, contents]) => {
    if ( Object.keys(contents).length === 0 ) delete data.flags[key];
  });

  if ( data.effects ) data.effects.forEach((i) => cleanPackEntry(i, { clearSourceId: false }));
  if ( data.items ) data.items.forEach((i) => cleanPackEntry(i, { clearSourceId: false }));
  if ( data.data?.description?.value ) data.data.description.value = cleanString(data.data.description.value);
  if ( data.label ) data.label = cleanString(data.label);
  if ( data.name ) data.name = cleanString(data.name);
}


/**
 * Attempts to find an existing matching ID for an item of this name, otherwise generates a new unique ID.
 * @param {object} data  Data for the entry that needs an ID.
 * @param {string} pack  Name of the pack to which this item belongs.
 * @return {Promise.<string>}  Resolves once the ID is determined.
 */
function determineId(data, pack) {
  const db_path = path.join(PACK_DEST, `${pack}.db`);
  if ( !DB_CACHE[db_path] ) {
    DB_CACHE[db_path] = new Datastore({ filename: db_path, autoload: true });
    DB_CACHE[db_path].loadDatabase();
  }
  const db = DB_CACHE[db_path];

  return new Promise((resolve, reject) => {
    db.findOne({ name: data.name }, (err, entry) => {
      if ( entry ) {
        resolve(entry._id);
      } else {
        resolve(db.createNewId());
      }
    });
  });
}

/**
 * Removes invisible whitespace characters and normalises single- and double-quotes.
 * @param {string} str  The string to be cleaned.
 * @returns {string}    The cleaned string.
 */
function cleanString(str) {
  return str.replace(/\u2060/gu, "").replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"');
}


/**
 * Cleans and formats source JSON files, removing unnecessary permissions and flags
 * and adding the proper spacing.
 *
 * - `gulp cleanPacks` - Clean all source JSON files.
 * - `gulp cleanPacks --pack classes` - Only clean the source files for the specified compendium.
 * - `gulp cleanPacks --pack classes --name Barbarian` - Only clean a single item from the specified compendium.
 */
function clean() {
  const packName = parsedArgs.pack;
  const entryName = parsedArgs.name?.toLowerCase();
  const folders = fs.readdirSync(PACK_SRC, { withFileTypes: true }).filter((file) =>
    file.isDirectory() && ( !packName || (packName === file.name) )
  );

  const packs = folders.map((folder) => {
    return gulp.src(path.join(PACK_SRC, folder.name, "/**/*.json"))
      .pipe(through2.obj(async (file, enc, callback) => {
        const json = JSON.parse(file.contents.toString());
        const name = json.name.toLowerCase();
        if ( entryName && (entryName !== name) ) return callback(null, file);
        cleanPackEntry(json);
        if ( !json._id ) json._id = await determineId(json, folder.name);
        fs.rmSync(file.path, { force: true });
        fs.writeFileSync(file.path, JSON.stringify(json, null, 2) + "\n", { mode: 0o664 });
        callback(null, file);
      }));
  });

  return mergeStream.call(null, packs);
}
exports.clean = clean;


/* ----------------------------------------- */
/*  Compile Packs
/* ----------------------------------------- */

/**
 * Compile the source JSON files into compendium packs.
 *
 * - `gulp compilePacks` - Compile all JSON files into their NEDB files.
 * - `gulp compilePacks --pack classes` - Only compile the specified pack.
 */
function compile() {
  const packName = parsedArgs.pack;
  // Determine which source folders to process
  const folders = fs.readdirSync(PACK_SRC, { withFileTypes: true }).filter((file) =>
    file.isDirectory() && ( !packName || (packName === file.name) )
  );

  const packs = folders.map((folder) => {
    const filePath = path.join(PACK_DEST, `${folder.name}.db`);
    fs.rmSync(filePath, { force: true });
    const db = fs.createWriteStream(filePath, { flags: "a", mode: 0o664 });
    const data = [];
    return gulp.src(path.join(PACK_SRC, folder.name, "/**/*.json"))
      .pipe(through2.obj((file, enc, callback) => {
        const json = JSON.parse(file.contents.toString());
        cleanPackEntry(json);
        data.push(json);
        callback(null, file);
      }, (callback) => {
        data.sort((lhs, rhs) => lhs._id > rhs._id ? 1 : -1);
        data.forEach(entry => db.write(JSON.stringify(entry) + "\n"));
        callback();
      }));
  });
  return mergeStream.call(null, packs);
}
exports.compile = compile;


/* ----------------------------------------- */
/*  Extract Packs
/* ----------------------------------------- */

/**
 * Extract the contents of compendium packs to JSON files.
 *
 * - `gulp extractPacks` - Extract all compendium NEDB files into JSON files.
 * - `gulp extractPacks --pack classes` - Only extract the contents of the specified compendium.
 * - `gulp extractPacks --pack classes --name Barbarian` - Only extract a single item from the specified compendium.
 */
function extract() {
  const packName = parsedArgs.pack ?? "*";
  const entryName = parsedArgs.name?.toLowerCase();
  const packs = gulp.src(`${PACK_DEST}/**/${packName}.db`)
    .pipe(through2.obj((file, enc, callback) => {
      const filename = path.parse(file.path).name;
      const folder = path.join(PACK_SRC, filename);
      if ( !fs.existsSync(folder) ) fs.mkdirSync(folder, { recursive: true, mode: 0o775 });

      const db = new Datastore({ filename: file.path, autoload: true });
      db.loadDatabase();

      db.find({}, (err, entries) => {
        entries.forEach(entry => {
          const name = entry.name.toLowerCase();
          if ( entryName && (entryName !== name) ) return;
          cleanPackEntry(entry);
          const output = JSON.stringify(entry, null, 2) + "\n";
          const outputName = name.replace("'", "").replace(/[^a-z0-9]+/gi, " ").trim().replace(/\s+|-{2,}/g, "-");
          const subfolder = path.join(folder, _getSubfolderName(entry, filename));
          if ( !fs.existsSync(subfolder) ) fs.mkdirSync(subfolder, { recursive: true, mode: 0o775 });
          fs.writeFileSync(path.join(subfolder, `${outputName}.json`), output, { mode: 0o664 });
        });
      });

      callback(null, file);
    }));

  return mergeStream.call(null, packs);
}
exports.extract = extract;


/**
 * Determine a subfolder name based on which pack is being extracted.
 * @param {object} data  Data for the entry being extracted.
 * @param {string} pack  Name of the pack.
 * @return {string}      Subfolder name the entry into which the entry should be created. An empty string if none.
 * @private
 */
function _getSubfolderName(data, pack) {
  switch (pack) {
    // Items should be grouped by type
    case "items":
      if ( (data.type === "consumable") && data.data.consumableType ) return data.data.consumableType;
      return data.type;

    // Monsters should be grouped by CR
    case "monsters":
      if ( !data.data?.details?.type?.value ) return "";
      return data.data.details.type.value;

    // Spells should be grouped by level
    case "spells":
      if ( data.data?.level === undefined ) return "";
      if ( data.data.level === 0 ) return "cantrip";
      return `level-${data.data.level}`;

    default: return "";
  }
}
