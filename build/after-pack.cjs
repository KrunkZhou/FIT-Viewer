const { copyFile, chmod } = require("node:fs/promises");
const { join } = require("node:path");

module.exports = async ({ electronPlatformName, appOutDir, packager }) => {
  if (electronPlatformName !== "linux") return;
  // AppImage staging copies this over the packager's fallback launcher.
  const launcher = join(appOutDir, "AppRun");
  await copyFile(join(packager.projectDir, "build", "AppRun"), launcher);
  await chmod(launcher, 0o755);
};
