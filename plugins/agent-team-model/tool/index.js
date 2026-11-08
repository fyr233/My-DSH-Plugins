import { loadHostPackage } from "../host.js";
import { withTeammateAgentOptions } from "../als.js";
import { pickSelectedRoute, pinCreationRoute, planTeammateModelChange, planTeammateRoute, pickMemberModel, sameRoute } from "../route.js";
// Host packages come from the running application rather than a static bare
// import: a directory-linked bundle has no node_modules, so Node's walk-up from
// this file cannot see the Host's copies and the module would fail to load.
// Importing the exact URLs the Host loaded keeps a single `dsh-tools` registry
// and a single TeamTaskId brand in the process.
const schemaLibrary = await loadHostPackage("@deepseek-ai/schemastery");
const z = schemaLibrary.default ?? schemaLibrary;
const { TeamTaskId } = await loadHostPackage("@deepseek-ai/dsh-experimental-agent-team");
const { parentAgentOptionsForDelegation } = await loadHostPackage("@deepseek-ai/dsh-subagent");
const { defineTool } = await loadHostPackage("@deepseek-ai/dsh-tools");
//#region lib/types/index.js
/** Scoped model-facing tools for the opt-in Agent Teams runtime. */
/** Cordis plugin name. */
const name = "tool-agent-team";
/** Services required by the Team tool plugin. */
const inject = [
	"agents",
	"agentTeams",
	"tools",
	"systemPrompt"
];
/** Loader schema for the opt-in Team tool plugin. */
const Config = z.object({
	interrupt: z.boolean().default(true),
	freshProvider: z.string().default("spawn"),
	forkProvider: z.string().default("fork")
});
/** Model-facing collaboration guidance shared by Lead and teammates. */
function teamPolicy(interrupt) {
	return `Agent Teams is available in this session

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use the target returned by spawn_teammate or list_agents for send_message${interrupt ? " and interrupt_agent" : ""}, or as owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A peer message starts with its sender name. A successful send does not mean the recipient has processed it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`;
}
const ACTIVE_WAIT_STATUSES = new Set(["running", "provisioning"]);
const NO_ACTIVE_PEER_MESSAGE = "No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.";
/**
* One model-facing roster row. The Lead pseudo-row omits the
* teammate-only provisioning fields, so only identity, role, status, and
* diagnostics are required.
*/
const MEMBER_VIEW_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		target: {
			type: "string",
			required: true
		},
		role: {
			type: "string",
			required: true,
			enum: ["lead", "teammate"]
		},
		status: {
			type: "string",
			required: true,
			enum: [
				"running",
				"inactive",
				"provisioning",
				"failed"
			]
		},
		description: { type: "string" },
		provider: { type: "string" },
		context: {
			type: "string",
			enum: ["fresh", "fork"]
		},
		model: { type: "string" },
		// Reported by set_teammate_model so the caller can confirm the applied
		// effort; the row schema declares it because `additionalProperties` is
		// false and an undeclared field would fail output validation.
		reasoningEffort: { type: "string" },
		// Reported by set_teammate_model so the caller can confirm the applied
		// effort; the row schema declares it because `additionalProperties` is
		// false and an undeclared field would fail output validation.
		diagnostics: {
			type: "array",
			required: true,
			items: { type: "string" }
		}
	}
};
/** Expose the member name as its model-facing target. */
function modelMember(member) {
	const { id: _id, name, ...details } = member;
	return {
		target: name,
		...details
	};
}
/** One shared task, matching the public `TeamTaskView`. */
const TASK_VIEW_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: {
			type: "string",
			required: true
		},
		revision: {
			type: "integer",
			required: true
		},
		subject: {
			type: "string",
			required: true
		},
		description: {
			type: "string",
			required: true
		},
		status: {
			type: "string",
			required: true,
			enum: [
				"pending",
				"in_progress",
				"completed",
				"deleted"
			]
		},
		ownerName: { type: "string" },
		blockedBy: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		writeScopes: {
			type: "array",
			required: true,
			items: { type: "string" }
		},
		ready: {
			type: "boolean",
			required: true
		},
		writeScopeWarnings: {
			type: "array",
			required: true,
			items: { type: "string" }
		}
	}
};
const SPAWN_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: { member: {
		...MEMBER_VIEW_SCHEMA,
		required: true
	} }
};
const MEMBER_LIST_VALUE_SCHEMA = {
	type: "array",
	items: MEMBER_VIEW_SCHEMA
};
const SEND_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: { sent: {
		type: "boolean",
		required: true,
		const: true
	} }
};
/** `noProgress` is present only on the model-only shortcut that skips the wait. */
const WAIT_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		timedOut: {
			type: "boolean",
			required: true
		},
		noProgress: {
			type: "object",
			additionalProperties: false,
			properties: {
				reason: {
					type: "string",
					required: true,
					const: "no-active-peer"
				},
				message: {
					type: "string",
					required: true
				}
			}
		}
	}
};
const INTERRUPT_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: { previousStatus: {
		type: "string",
		required: true,
		enum: ["running", "inactive"]
	} }
};
const TASK_LIST_VALUE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		tasks: {
			type: "array",
			required: true,
			items: TASK_VIEW_SCHEMA
		},
		nextCursor: { type: "integer" }
	}
};
/**
* Declare one canonical output schema with compact model-facing JSON. Every
* Team result is a fixed record, so the declared schema is what makes the
* compiler check `execute` against the value the model is promised.
* @param schema - canonical value schema for one tool.
* @returns the `output` declaration accepted by {@link defineTool}.
*/
function jsonOutput(schema) {
	return {
		schema,
		render: (_args, value) => [{
			type: "text",
			text: JSON.stringify(value)
		}]
	};
}
/** Recover the exact caller guaranteed by Agent-scoped tool discovery. */
function callingAgent(agent, toolName) {
	/* v8 ignore next 2 -- Team tools are registered only in an exact Agent scope, so discovery supplies this carrier. */
	if (agent === void 0) throw new Error(`${toolName} requires a calling Agent`);
	return agent;
}
/**
* The Lead's effective route. Uses the host resolver so a model switched in the
* UI (which lands in the request header, not in creation options) is honoured.
*/
function leadRoute(agent) {
	const options = parentAgentOptionsForDelegation(agent);
	return {
		provider: options.provider,
		model: options.model,
		reasoningEffort: options.reasoningEffort
	};
}
/**
* Fail before creating the member when the route cannot be called at all.
* Without this a bad model id leaves an `active` teammate that never produces
* output, because the failure surfaces only on the child's first request.
*
* `planTeammateRoute` already refuses to return without an effective provider and
* model, so this function only has to prove the route is callable.
*/
async function assertRoutable(ctx, plan, signal) {
	const llm = ctx.get("llm");
	if (llm === void 0) {
		/* v8 ignore next -- the Host always composes the LLM runtime. */
		ctx.logger?.warn?.("agent-team-model: llm service is missing; skipping the teammate route preflight");
		/* v8 ignore next -- see above. */
		return;
	}
	await llm.resolveCallConfig({
		provider: plan.provider,
		model: plan.model,
		...plan.reasoningEffort === void 0 ? {} : { reasoningEffort: plan.reasoningEffort }
	}, signal);
}
/**
* Plan and preflight the child route for one spawn.
* @returns child AgentOptions to tag onto the spawn, or undefined to inherit.
*/
async function resolveTeammateAgentOptions(ctx, agent, args, signal) {
	const plan = planTeammateRoute(ctx.get("subagentModelSelection"), leadRoute(agent), args);
	if (plan === void 0) return void 0;
	await assertRoutable(ctx, plan, signal);
	return plan.agentOptions;
}
/** Register the complete Team tool set in one exact Agent scope. */
function install(agent, ctx, config, seam) {
	const scoped = agent.ctx;
	const disposers = [];
	const register = (disposer) => {
		disposers.push(disposer);
	};
	/** Undo every registration made so far. Safe to call more than once. */
	const dispose = () => {
		for (const undo of disposers.splice(0).reverse()) undo();
	};
	try {
		// The route is maintained from apply()'s agent/created hook, not from a
		// per-step listener. A pre-step rewrite cannot work here anyway:
		// systemPrompt.assemble() runs BEFORE agent/pre-step, and agent/request is
		// built from the selection snapshotted during assemble, so writing in
		// pre-step only ever affects the following step.
		// The team:policy section is registered once in plugin scope by apply(),
		// not here. systemPrompt.section() ties its effect to the *calling* ctx, so
		// registering it on agent.ctx would outlive the plugin and collide the next
		// time the plugin loads ("already registered in this scope"). Its text only
		// depends on config.interrupt, so one plugin-scoped registration is enough.
		register(scoped.systemPrompt.context({
			name: "team:identity",
			order: scoped.systemPrompt.getContextOrder("TEAM_IDENTITY"),
			required: true,
			text: () => {
				// Runs during prompt assembly: a TeamError here (membership can be gone
				// after the Lead's Session ends) would fail the whole step, so the
				// non-throwing lookup is used and a missing membership yields no text.
				const membership = ctx.agentTeams.tryMembership(agent);
				if (membership === void 0) return "";
				const { role, name } = membership;
				return `${role === "lead" ? "You are the Team Lead named \"lead\"." : `You are teammate "${name}".\nYour Team Lead is named "lead".\nTo message your Team Lead, use send_message({ target: "lead", message: "..." }).`}
Use list_agents({}) to find your teammates and their names.
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).`;
			}
		}));
		register(scoped.tools.register(defineTool({
			name: "spawn_teammate",
			description: "Create one named, durable teammate. Only the Team Lead may call this tool.",
			parameters: {
				name: {
					type: "string",
					required: true,
					description: "Unique lower-kebab-case teammate name."
				},
				description: {
					type: "string",
					required: true,
					description: "Short description of the delegated responsibility."
				},
				prompt: {
					type: "string",
					required: true,
					description: "Complete initial task for the teammate."
				},
				context: {
					type: "string",
					enum: ["fresh", "fork"],
					description: "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh."
				},
				model: {
					type: "string",
					description: "LLM model id for this teammate. Omit to inherit the Lead's model."
				},
				provider: {
					type: "string",
					description: "LLM provider id for this teammate. Requires `model`; omit to inherit the Lead's provider."
				},
				reasoning_effort: {
					type: "string",
					description: "Reasoning effort for this teammate. Omit to use the selected model's default."
				}
			},
			output: jsonOutput(SPAWN_VALUE_SCHEMA),
			async execute(args, exec) {
				const agent = callingAgent(exec.agent, "spawn_teammate");
				const context = args.context ?? "fresh";
				const agentOptions = await resolveTeammateAgentOptions(ctx, agent, args, exec.signal);
				const spawned = await withTeammateAgentOptions(agentOptions, () => ctx.agentTeams.spawnTeammate(agent, {
					name: args.name,
					description: args.description,
					prompt: [{
						type: "text",
						text: args.prompt
					}],
					context,
					provider: context === "fork" ? config.forkProvider : config.freshProvider,
					signal: exec.signal
				}));
				return { member: modelMember(spawned.member) };
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "set_teammate_model",
			description: "Change one existing teammate's LLM route. Applies to a teammate, never the Lead. The change takes effect from the target's next request; routing is resolved per step, so a multi-step turn switches at its next step, while a request already awaiting a reply finishes on the old route.",
			parameters: {
				target: {
					type: "string",
					required: true,
					description: "Teammate target returned by spawn_teammate or list_agents."
				},
				model: {
					type: "string",
					description: "New model id for this teammate."
				},
				provider: {
					type: "string",
					description: "New provider id. Requires `model`; omitted keeps the member's provider."
				},
				reasoning_effort: {
					type: "string",
					description: "New reasoning effort. Omitted lets a changed model use its own default."
				}
			},
			output: jsonOutput(MEMBER_VIEW_SCHEMA),
			async execute(args, exec) {
				const caller = callingAgent(exec.agent, "set_teammate_model");
				const row = ctx.agentTeams.listMembers(caller).find((member) => member.name === args.target);
				if (row === void 0) throw new Error(`set_teammate_model: no teammate named "${args.target}"`);
				if (row.role !== "teammate") throw new Error("set_teammate_model: the Team Lead cannot change its own model");
				const live = ctx.agents.get(row.id);
				const session = live?.session ?? ctx.get("sessions")?.get(row.id);
				const projection = session === void 0 ? void 0 : ctx.get("sessionProjections")?.stateOf(session, "modelSelection");
				// A stopped member has no attached Session, so its current route is read
				// from the persisted log — that is what a resumed Agent would seed from.
				const previous = pickSelectedRoute(projection)
					?? seam.peek(row.id)
					?? (live === void 0 ? await seam.persistedRoute(row.id) : void 0)
					?? seam.recall(row.id)
					?? {
						provider: live?.options.provider,
						model: live?.options.model,
						reasoningEffort: live?.options.reasoningEffort
					};
				const selection = planTeammateModelChange(ctx.get("subagentModelSelection"), previous, args);
				// One response shape whether or not anything had to be written: report the
				// route the member resolves to now. Returning the raw roster row here used
				// to leak its creation-time (or Lead-derived) model, so a no-op was
				// indistinguishable from a change.
				const answer = {
					...modelMember(row),
					model: selection.model,
					provider: selection.provider,
					...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
				};
				// Compare against the route we resolved, not just the projection: a stopped
				// member's current route comes from its persisted log, and ignoring that
				// made an already-correct member look like it needed another write.
				if (sameRoute(previous, selection)) return answer;
				const llm = ctx.get("llm");
				if (llm !== void 0) await llm.resolveCallConfig({
					provider: selection.provider,
					model: selection.model,
					...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort }
				}, exec.signal);
				// Record the intent BEFORE the branch, for both paths. The record is what
				// survives into the next Agent instance, so a live change that skipped it
				// left an older route behind — and that older route then won on the next
				// wake-up, reverting the member to a route the user had already replaced.
				seam.defer(row.id, selection);
				// A stopped teammate has no attached Session to write into, so the record
				// above is all there is until it starts (see apply()). A live one also gets
				// the event written immediately.
				if (live !== void 0) seam.apply(live, selection);
				seam.remember(row.id, selection);
				return answer;
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "send_message",
			description: "Send one message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.",
			parameters: {
				target: {
					type: "string",
					required: true,
					description: "Member target returned by spawn_teammate or list_agents, including lead."
				},
				message: {
					type: "string",
					required: true,
					description: "Self-contained message for the target."
				}
			},
			output: jsonOutput(SEND_VALUE_SCHEMA),
			async execute(args, exec) {
				await ctx.agentTeams.sendMessage(callingAgent(exec.agent, "send_message"), {
					target: args.target,
					content: [{
						type: "text",
						text: args.message
					}],
					signal: exec.signal
				});
				return { sent: true };
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "list_agents",
			description: "List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.",
			parameters: {},
			output: jsonOutput(MEMBER_LIST_VALUE_SCHEMA),
			execute(_args, exec) {
				const members = ctx.agentTeams.listMembers(callingAgent(exec.agent, "list_agents"));
				return Promise.resolve(members.map((member) => {
					const view = modelMember(member);
					// The roster's own model is the creation-time value, and for a
					// non-live member it falls back to the Lead's route. Prefer the
					// Session's live selection and omit the field when it cannot be
					// resolved, so one member's model never stands in for another's.
					const live = ctx.agents.get(member.id);
					const session = live?.session ?? ctx.get("sessions")?.get(member.id);
					const projection = session === void 0 ? void 0 : ctx.get("sessionProjections")?.stateOf(session, "modelSelection");
					// A route chosen while the member was stopped is the newest intent, and
					// it cannot show up in the projection yet. Failing that, the last route
					// this plugin observed beats the roster's Lead-derived fallback.
					const model = seam.peek(member.id)?.model
						?? seam.recall(member.id)?.model
						?? pickMemberModel(projection, live?.options);
					return model === void 0 ? view : {
						...view,
						model
					};
				}));
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "wait_agent",
			description: "Wait for the next teammate status, message, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.",
			parameters: { timeout_ms: {
				type: "integer",
				description: "Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000."
			} },
			output: jsonOutput(WAIT_VALUE_SCHEMA),
			async execute(args, exec) {
				const caller = callingAgent(exec.agent, "wait_agent");
				const timeoutMs = args.timeout_ms ?? 3e4;
				if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1e4 || timeoutMs > 36e5) return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal);
				if (!ctx.agentTeams.listMembers(caller).some((member) => member.id !== caller.id && ACTIVE_WAIT_STATUSES.has(member.status))) return {
					timedOut: false,
					noProgress: {
						reason: "no-active-peer",
						message: NO_ACTIVE_PEER_MESSAGE
					}
				};
				return await ctx.agentTeams.waitForChange(caller, timeoutMs, exec.signal);
			}
		})));
		if (config.interrupt) register(scoped.tools.register(defineTool({
			name: "interrupt_agent",
			description: "Interrupt one teammate's current turn while preserving its pending inbox. Team Lead only.",
			parameters: { target: {
				type: "string",
				required: true,
				description: "Teammate target returned by spawn_teammate or list_agents."
			} },
			output: jsonOutput(INTERRUPT_VALUE_SCHEMA),
			execute(args, exec) {
				return Promise.resolve(ctx.agentTeams.interrupt(callingAgent(exec.agent, "interrupt_agent"), args.target));
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "team_task_create",
			description: "Create one unowned pending task on the shared Team task board.",
			parameters: {
				subject: {
					type: "string",
					required: true,
					description: "Concise task title."
				},
				description: {
					type: "string",
					required: true,
					description: "Complete task details and acceptance criteria."
				},
				blocked_by: {
					type: "array",
					items: { type: "string" },
					description: "Task ids that must complete first."
				},
				write_scopes: {
					type: "array",
					items: { type: "string" },
					description: "Advisory workspace-relative file or directory prefixes this task expects to modify."
				}
			},
			output: jsonOutput(TASK_VIEW_SCHEMA),
			async execute(args, exec) {
				return await ctx.agentTeams.createTask(callingAgent(exec.agent, "team_task_create"), {
					subject: args.subject,
					description: args.description,
					...args.blocked_by === void 0 ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
					...args.write_scopes === void 0 ? {} : { writeScopes: args.write_scopes }
				});
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "team_task_list",
			description: "List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.",
			parameters: {
				status: {
					type: "string",
					enum: [
						"pending",
						"in_progress",
						"completed"
					],
					description: "Optional exact status filter."
				},
				owner: {
					type: "string",
					description: "Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner."
				},
				ready: {
					type: "boolean",
					description: "Optional readiness filter."
				},
				cursor: {
					type: "integer",
					description: "Zero-based result offset. Defaults to 0."
				},
				limit: {
					type: "integer",
					description: "Number of rows, 1 through 100. Defaults to 50."
				}
			},
			output: jsonOutput(TASK_LIST_VALUE_SCHEMA),
			execute(args, exec) {
				const status = args.status;
				const filtered = ctx.agentTeams.listTasks(callingAgent(exec.agent, "team_task_list")).filter((task) => (status === void 0 || task.status === status) && (args.owner === void 0 || (args.owner === "unowned" ? task.ownerName === void 0 : task.ownerName === args.owner)) && (args.ready === void 0 || task.ready === args.ready));
				const cursor = args.cursor ?? 0;
				const limit = args.limit ?? 50;
				if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative safe integer");
				if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 through 100");
				return Promise.resolve({
					tasks: filtered.slice(cursor, cursor + limit),
					...cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}
				});
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "team_task_get",
			description: "Read the complete latest value of one shared task before changing or executing it.",
			parameters: { task_id: {
				type: "string",
				required: true,
				description: "Shared task id."
			} },
			output: jsonOutput(TASK_VIEW_SCHEMA),
			async execute(args, exec) {
				return Promise.resolve(ctx.agentTeams.getTask(callingAgent(exec.agent, "team_task_get"), TeamTaskId(args.task_id)));
			}
		})));
		register(scoped.tools.register(defineTool({
			name: "team_task_update",
			description: "Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.",
			parameters: {
				task_id: {
					type: "string",
					required: true,
					description: "Shared task id."
				},
				expected_revision: {
					type: "integer",
					required: true,
					description: "Current task revision used as the CAS precondition."
				},
				action: {
					type: "string",
					required: true,
					enum: [
						"claim",
						"release",
						"edit",
						"set_dependencies",
						"complete",
						"reopen",
						"reassign",
						"delete"
					],
					description: "Task transition to apply."
				},
				subject: {
					type: "string",
					description: "Replacement title for edit."
				},
				description: {
					type: "string",
					description: "Replacement details for edit."
				},
				blocked_by: {
					type: "array",
					items: { type: "string" },
					description: "Complete blocker list for set_dependencies."
				},
				write_scopes: {
					type: "array",
					items: { type: "string" },
					description: "Replacement advisory write scopes for edit."
				},
				owner: {
					type: "string",
					description: "Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign."
				}
			},
			output: jsonOutput(TASK_VIEW_SCHEMA),
			async execute(args, exec) {
				return await ctx.agentTeams.updateTask(callingAgent(exec.agent, "team_task_update"), {
					taskId: TeamTaskId(args.task_id),
					expectedRevision: args.expected_revision,
					action: args.action,
					...args.subject === void 0 ? {} : { subject: args.subject },
					...args.description === void 0 ? {} : { description: args.description },
					...args.blocked_by === void 0 ? {} : { blockedBy: args.blocked_by.map(TeamTaskId) },
					...args.write_scopes === void 0 ? {} : { writeScopes: args.write_scopes },
					...args.owner === void 0 ? {} : { owner: args.owner }
				});
			}
		})));
	} catch (error) {
		dispose();
		throw error;
	}
	// Draining through splice() makes a second call a no-op, which matters when a
	// failed install is followed by a teardown of the same scope.
	return dispose;
}
/** Install Team tools in every live or subsequently published Team member scope. */
function apply(ctx, config = {}) {
	const resolved = {
		interrupt: config.interrupt ?? true,
		freshProvider: config.freshProvider ?? "spawn",
		forkProvider: config.forkProvider ?? "fork"
	};
	// A teammate that is not running has no attached Session, so its
	// `model/selection` event cannot be written yet. The route is recorded here
	// instead and applied the moment the agent is created again: by then the
	// Session exists, and the Host's selectionFor() reads the projection's
	// `pending` value on first install, so the member's very next request already
	// uses the new route.
	const deferredRoutes = /* @__PURE__ */ new Map();
	// Last route actually observed for a member during this plugin's lifetime. The
	// durable answer for a stopped member comes from its persisted Session (see
	// lastPersistedRoute); this is the cheap in-memory fallback for when that read
	// is unavailable.
	const knownRoutes = /* @__PURE__ */ new Map();
	const seam = {
		defer(sessionId, selection) {
			deferredRoutes.set(sessionId, selection);
		},
		peek(sessionId) {
			return deferredRoutes.get(sessionId);
		},
		/** Remember the route a member was last seen using. */
		remember(sessionId, route) {
			if (route?.provider !== void 0 && route?.model !== void 0) knownRoutes.set(sessionId, route);
		},
		/** The last observed route for a member, or undefined when never seen. */
		recall(sessionId) {
			return knownRoutes.get(sessionId);
		},
		/**
		 * The route a stopped member last ran with, read from its persisted Session.
		 *
		 * `inspect()` is the documented cold read ("without activating its Agent"), and
		 * the folded `request/header` events are exactly what a resumed Agent would seed
		 * itself from. Returns undefined when the Session cannot be read, so callers
		 * fall back to the in-memory record instead of failing.
		 */
		async persistedRoute(sessionId) {
			const controller = ctx.get("sessionController");
			if (typeof controller?.inspect !== "function") return void 0;
			// Reading a persisted log is proportional to its size (measured: ~390 ms for
			// 1.9 MB, so a long-lived member can reach seconds). This sits on a tool
			// call, so it is bounded: on timeout the caller falls back to the in-memory
			// record and still gets a usable answer.
			const timeout = AbortSignal.timeout(5000);
			let inspection
			try {
				inspection = await controller.inspect(sessionId, timeout);
			} catch {
				return void 0;
			}
			const events = inspection?.events;
			if (!Array.isArray(events)) return void 0;
			for (let index = events.length - 1; index >= 0; index -= 1) {
				const event = events[index];
				if (event?.type !== "request/header") continue;
				const config = event.data?.header?.config;
				if (config?.provider === void 0 || config?.model === void 0) return void 0;
				return {
					provider: config.provider,
					model: config.model,
					reasoningEffort: event.data?.header?.adapterDefaults?.reasoningEffort === true ? void 0 : config.reasoningEffort
				};
			}
			return void 0;
		},
		/**
		 * Install the Host's own model-selection machinery for this Agent instance.
		 *
		 * This is the part that actually decides the request route: selectionFor()
		 * registers the `agent/request` listener that overwrites provider/model from
		 * the Session's selection. Without it the loop seeds the request from
		 * `AgentOptions` — the route the member was spawned with — so a changed route
		 * silently reverts on the next instance. It is idempotent (one selection per
		 * agent, kept in a WeakMap) and writes no event.
		 * @returns the installed selection, whose `current` is the effective route.
		 */
		ensure(live) {
			const agents = ctx.get("sessionController")?.agents;
			if (typeof agents?.selectionFor !== "function") throw new Error("set_teammate_model: this Host does not expose the Session model-selection seam; restart the app after upgrading");
			return agents.selectionFor(live);
		},
		apply(live, selection) {
			const controller = ctx.get("sessionController");
			const select = controller?.agents?.selectForNextRequest;
			if (typeof select !== "function") throw new Error("set_teammate_model: this Host does not expose the Session model-selection seam; restart the app after upgrading");
			select.call(controller.agents, live, selection);
		}
	};
	const installed = /* @__PURE__ */ new Map();
	const maybeInstall = (agent) => {
		if (installed.has(agent) || ctx.agentTeams.tryMembership(agent) === void 0) return;
		// Runs inside the agent/created listener. `install()` throws when one of its
		// registrations fails — a duplicate tool name, for instance, which is exactly
		// what happens when the built-in tool-agent-team is also active. Letting that
		// escape would break the member's creation; the member is better off with
		// this plugin's tools missing and a warning in the log.
		let dispose
		try {
			dispose = install(agent, ctx, resolved, seam)
		} catch (error) {
			ctx.logger?.warn?.(`agent-team-model: could not install the Team tools for "${agent.id}": ${error instanceof Error ? error.message : String(error)}`);
			return
		}
		installed.set(agent, dispose);
		// Only teammates are ever routed by this plugin. The Lead's model belongs to
		// its own Session and to the user's picker; touching it once re-routed a live
		// Lead Session by mistake, so the role check is structural rather than
		// advisory: the Lead returns before any selection work happens.
		const membership = ctx.agentTeams.tryMembership(agent);
		if (membership?.role !== "teammate") return;
		// Every teammate needs the Host's selection machinery installed, whether or not
		// this plugin has a route to apply. Skipping it when the Session already showed
		// the wanted route was the bug that made a change lapse: the guard was true on
		// the second instance, so `selectionFor()` never ran, the `agent/request`
		// override was absent, and the request fell back to the spawn-time route.
		let selection
		try {
			selection = seam.ensure(agent);
		} catch (error) {
			ctx.logger?.warn?.(`agent-team-model: could not install model selection for "${agent.id}": ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		// Only a route recorded for this very Session may be applied, and only when it
		// differs from what the Session already resolves to. Reading the selection
		// rather than a projection keeps this free of identity assumptions.
		const wanted = seam.peek(agent.id);
		// A brand-new Session has no request header yet, and selectionFor() then falls
		// back to the DEPLOYMENT DEFAULT model. Since installing the seam also installs
		// the request override, that default would replace the route the member was
		// spawned with. Pin the selection to the member's own creation route instead,
		// which is exactly what the loop would have used without the seam.
		const pinned = pinCreationRoute({
			hasHeader: agent.session.requestHeader() !== void 0,
			wanted,
			own: agent.options
		});
		if (pinned !== void 0) selection.current = pinned;
		seam.remember(agent.id, selection.current);
		if (wanted === void 0 || sameRoute(selection.current, wanted)) return;
		try {
			seam.apply(agent, wanted);
		} catch (error) {
			ctx.logger?.warn?.(`agent-team-model: could not apply the recorded route to "${agent.id}": ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	// One plugin-scoped policy section. Registering it per agent would tie the
	// effect to that agent's ctx (see systemPrompt.section), so it would survive a
	// plugin unload and make the next load fail with "already registered".
	ctx.effect(() => ctx.systemPrompt.section({
		name: "team:policy",
		order: ctx.systemPrompt.getSectionOrder("TEAM_POLICY"),
		text: teamPolicy(resolved.interrupt)
	}), "tool-team.policy()");
	for (const agent of ctx.agents.list()) maybeInstall(agent);
	ctx.on("agent/created", ({ agent }) => {
		maybeInstall(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		// An undo can throw (it is a Host-provided disposer). Letting that escape
		// would both reach the Host's disposal path and skip the bookkeeping below,
		// leaving the entry behind to be disposed again later.
		try {
			installed.get(agent)?.();
		} catch (error) {
			ctx.logger?.warn?.(`agent-team-model: could not release the Team tools for "${agent.id}": ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			installed.delete(agent);
		}
	});
	ctx.effect(() => () => {
		for (const agent of [...installed.keys()]) {
			try {
				installed.get(agent)?.();
			} catch (error) {
				ctx.logger?.warn?.(`agent-team-model: could not release the Team tools for "${agent.id}": ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		installed.clear();
	}, "tool-team.scopedTools()");
}
//#endregion
export { Config, apply, inject, name };
