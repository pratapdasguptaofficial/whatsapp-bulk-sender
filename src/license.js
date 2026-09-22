const fs = require('fs-extra');
const path = require('path');
const { app } = require('electron');

const licenseFile = path.join(app.getPath('userData'), 'license.json');

function isLicenseValid() {
  try {
    if (!fs.existsSync(licenseFile)) return false;
    const data = fs.readJsonSync(licenseFile);
    const expiry = new Date(data.expiry_date);
    const today = new Date();
    return expiry > today;
  } catch {
    return false;
  }
}

function getLicenseData() {
  try {
    if (!fs.existsSync(licenseFile)) return null;
    return fs.readJsonSync(licenseFile);
  } catch {
    return null;
  }
}

function clearLicense() {
  try {
    if (fs.existsSync(licenseFile)) {
      fs.removeSync(licenseFile);
    }
  } catch {
    // ignore
  }
}

module.exports = { isLicenseValid, getLicenseData, clearLicense };