// Read-only patchStatus check against the installed pi. Not part of the suite.
import { patchStatus } from "../src/patcher.js";

const s = patchStatus();
console.log(
	JSON.stringify(
		{
			present: s.present,
			root: s.root,
			version: s.version,
			missing: s.missing,
			backupVersion: s.backupVersion,
		},
		null,
		1,
	),
);
