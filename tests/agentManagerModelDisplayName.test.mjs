import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

function createManager(config, { runtimeName = "runtime-raw-name", thinkingLevel = "high", runtimeBaseUrl = null } = {}) {
	const requests = [];
	let modelConfigReads = 0;
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{
			getModelsConfig: async () => {
				modelConfigReads += 1;
				return config;
			},
		},
	);
	manager.agents.set("agent-1", {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "idle",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: {
			client: {
				request: async ({ type }) => {
					requests.push(type);
					if (type === "get_state") {
						return {
							success: true,
							data: {
								// runtimeName=null 表示 Pi 未返回 name 字段（缺省值 undefined 会被解构默认值覆盖）
								model: { provider: "router9", id: "qd/qfmodel", ...(runtimeName !== null ? { name: runtimeName } : {}), ...(runtimeBaseUrl === null ? {} : { baseUrl: runtimeBaseUrl }) },
								thinkingLevel,
							},
						};
					}
					return { success: true, data: {} };
				},
			},
		},
	});
	return { manager, requests, getModelConfigReads: () => modelConfigReads };
}

function modelsConfig(name) {
	return {
		parsed: {
			providers: {
				router9: {
					models: [{ id: "qd/qfmodel", name }],
				},
			},
		},
	};
}

test("getRuntimeState: Pi runtime model.name wins without reading local aliases", async () => {
	const harness = createManager(modelsConfig("local-alias"));

	const state = await harness.manager.getRuntimeState("agent-1");

	assert.equal(state.provider, "router9");
	assert.equal(state.modelId, "qd/qfmodel");
	assert.equal(state.modelName, "runtime-raw-name");
	assert.equal(harness.getModelConfigReads(), 0);
});

test("getRuntimeState: endpoint origin comes from actual Pi RPC without exposing credentials/path/query", async () => {
	const harness = createManager(undefined, { runtimeBaseUrl: "https://user:private-pass@api.example.test:8443/private-token/v1?api_key=secret#secret" });
	const state = await harness.manager.getRuntimeState("agent-1");
	assert.equal(state.modelEndpointOrigin, "https://api.example.test:8443");
	assert.equal(harness.getModelConfigReads(), 0);
});

test("getRuntimeState: missing, malformed or non-HTTP endpoint is unknown, never inferred from provider", async () => {
	for (const runtimeBaseUrl of [null, "not-a-url", "file:///private/path", "javascript:secret", "https://api.test/" + "x".repeat(4096)]) {
		const harness = createManager(undefined, { runtimeBaseUrl });
		assert.equal((await harness.manager.getRuntimeState("agent-1")).modelEndpointOrigin, undefined);
	}
});

test("getRuntimeState: blank runtime name falls back to model ID", async () => {
	const harness = createManager(modelsConfig("local-alias"), { runtimeName: "   " });

	const state = await harness.manager.getRuntimeState("agent-1");

	assert.equal(state.modelName, "qd/qfmodel");
	assert.equal(harness.getModelConfigReads(), 0);
});

test("getRuntimeState: absent runtime name falls back to model ID", async () => {
	const harness = createManager(undefined, { runtimeName: null });

	const state = await harness.manager.getRuntimeState("agent-1");

	assert.equal(state.modelName, "qd/qfmodel");
	assert.equal(harness.getModelConfigReads(), 0);
});

test("getRuntimeModelThinkingState reads the actual model and effort with one get_state RPC", async () => {
	const harness = createManager(modelsConfig("local-alias"), { runtimeName: "Pi model name", thinkingLevel: "high" });

	const state = await harness.manager.getRuntimeModelThinkingState("agent-1");

	assert.deepEqual(JSON.parse(JSON.stringify(state)), {
		provider: "router9",
		modelId: "qd/qfmodel",
		modelName: "Pi model name",
		thinkingLevel: "high",
	});
	assert.deepEqual(harness.requests, ["get_state"]);
	assert.equal(harness.getModelConfigReads(), 0);
});
