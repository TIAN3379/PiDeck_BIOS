/** Isolated synthetic knowledge only; never point this fixture at a real store. */
import { existsSync } from "node:fs";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createExperienceDraft, createFeature, reviewExperience } from "../packages/bios-agent/core/knowledge/index.ts";

const [root, workspace] = process.argv.slice(2);
if (!root || !workspace || existsSync(root)) throw new Error("Provide a new synthetic knowledge root and workspace");
await initializeKnowledgeStore({ root });
// Deliberately reproduces the old path-only binding without desktopProjectId.
const binding = await bindProjectWorkspace({ root, cwd: workspace, workspacePath: workspace, authorizedRoots: [workspace], displayName: "Synthetic library board" });
for (const experienceId of ["exp-draft", "exp-reviewed"]) {
	const created = await createExperienceDraft({
		root,
		authorizedProjectIds: [binding.projectId],
		experience: { experienceId, sourceProjectId: binding.projectId, problem: experienceId === "exp-draft" ? "S3 synthetic issue" : "Reviewed synthetic issue", rootCause: "Synthetic cause", solution: "Original synthetic solution", appliesWhen: ["Synthetic platform"], doesNotApplyWhen: ["Different board"] },
	});
	if (experienceId === "exp-reviewed") await reviewExperience({ root, experienceId, expectedRevision: created.revision, action: "submit-review", operatorLabel: "Synthetic reviewer", reason: "GUI fixture", authorizedProjectIds: [binding.projectId] });
}
await createFeature({ root, feature: { featureId: "feature-pxe", originalRequirement: "Synthetic PXE requirement", aliases: ["network boot"] } });
process.stdout.write(JSON.stringify({ projectId: binding.projectId }));
