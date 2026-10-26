import { restoreDatabaseFromBackup } from "../src/dbBackup.js";

(async () => {
  try {
    const backupFile = await restoreDatabaseFromBackup();
    console.log(`Database restore test completed using backup file: ${backupFile}`);
    process.exit(0);
  } catch (error) {
    console.error("Database restore test failed:", error);
    process.exit(1);
  }
})();
