const fs = require("fs");
const path = require("path");

function findProjectRoot(startDir: string): string {
  let current = path.resolve(startDir);

  while (true) {
    const packagePath = path.join(current, "package.json");

    if (fs.existsSync(packagePath)) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      throw new Error(`Unable to find project root from ${startDir}.`);
    }

    current = parent;
  }
}

const PROJECT_ROOT = findProjectRoot(__dirname);

module.exports = {
  PROJECT_ROOT,
  findProjectRoot,
};
