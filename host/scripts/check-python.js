#!/usr/bin/env node
/**
 * Post-install script to check Python dependencies.
 * Mosaic requires Python 3.11+ and the lee-tools package.
 */

const { execSync } = require('child_process');

function checkPython() {
  try {
    const version = execSync('python3 --version', { encoding: 'utf-8' });
    console.log(`Found: ${version.trim()}`);

    // Check version >= 3.11
    const match = version.match(/Python (\d+)\.(\d+)/);
    if (match) {
      const [, major, minor] = match;
      if (parseInt(major) < 3 || (parseInt(major) === 3 && parseInt(minor) < 11)) {
        console.warn('Warning: Python 3.11+ recommended for lee-tools');
      }
    }
  } catch (error) {
    console.warn('Warning: Python 3 not found. Lee editor requires Python 3.11+');
    console.warn('Install Python from https://www.python.org/downloads/');
  }
}

function checkLeeTools() {
  try {
    execSync('python3 -c "import editor"', { encoding: 'utf-8', stdio: 'pipe' });
    console.log('Found: lee-tools package');
  } catch (error) {
    console.warn('Warning: lee-tools not installed.');
    console.warn('Install with: pip install lee-tools');
    console.warn('Or from source: cd lee && pip install -e .');
  }
}

console.log('Checking Mosaic dependencies...');
checkPython();
checkLeeTools();
console.log('Done.');
