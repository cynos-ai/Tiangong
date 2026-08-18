SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

AGENTTEAMS := ./scripts/agentteams.sh
AGENTTEAMS_BOOTSTRAP_TEST := ./scripts/test-agentteams.sh
WORKER_IMAGE_BUILD := ./scripts/build-worker-image.sh
COORDINATION_IMAGE_BUILD := ./scripts/build-coordination-image.sh
COORDINATION_RUNTIME_DEPLOY := ./scripts/deploy-coordination-runtime.sh
LEADER_RUNTIME_INJECTION_TEST := ./scripts/test-leader-runtime-injection.sh
LEADER_RUNTIME_DOCKER_INJECTION_TEST := ./scripts/test-leader-runtime-injection-docker.sh
B5_ROLE_RUNTIME_INJECTION_TEST := ./scripts/test-b5-role-runtime-injection-docker.sh
WORKER_IMAGE_TEST := ./smoke-testing/support/run-worker-smoke.sh
LEADER_SMOKE := ./smoke-testing/support/run-leader-smoke.sh
LEADER_SMOKE_TEST := ./scripts/test-leader-smoke.sh
PEER_MENTION_SMOKE := ./smoke-testing/support/run-peer-mention-smoke.sh
PEER_MENTION_SMOKE_TEST := ./scripts/test-peer-mention-smoke.sh
MATRIX_BROWSER_SMOKE := ./smoke-testing/support/run-matrix-browser-smoke.sh
MATRIX_BROWSER_SMOKE_TEST := ./scripts/test-matrix-browser-smoke.sh
SPECIALIST_HANDOFF_SMOKE := ./smoke-testing/support/run-specialist-leader-handoff.sh
P0_IDENTITY_PG_CONTRACT := ./scripts/test-p0-identity-pg.sh
P0_MENTION_DELIVERY := ./scripts/test-p0-2-mention.sh
SPECIALIST_HANDOFF_SMOKE_TEST := ./scripts/test-specialist-leader-handoff.sh
RUNNER_ISOLATION_SPIKE := ./smoke-testing/support/run-runner-isolation-spike.sh
RUNNER_EXECUTOR_SMOKE := node ./smoke-testing/support/run-runner-executor-smoke.mjs
RUNNER_BROKER_SMOKE := node ./smoke-testing/support/run-runner-broker-smoke.mjs
RUNNER_BROKER := ./scripts/runner-broker.sh
RUNNER_PREPARATION_SMOKE := ./smoke-testing/support/run-runner-preparation-smoke.sh
DEPLOYMENT_SERVICE_SMOKE := node ./smoke-testing/support/run-deployment-service-smoke.mjs
SKILL_CHECK := node ./scripts/check-skills.mjs
PAUSE_WORKER_BOUNDARY_TEST := ./scripts/test-pause-worker-boundary.sh
PHASE4_RECOVERY_TEST := node ./worker/test/phase4-recovery.test.mjs
B5_RUNTIME_ROUTE_TEST := node ./worker/test/runtime-routing.test.mjs
B5_RECOVERY_TEST := node ./worker/test/phase-b5-recovery.test.mjs
B5_RECOVERY_CLI_TEST := node ./worker/test/work-run-recovery-cli.test.mjs
B5_VERTICAL_TEST := node ./worker/test/phase-b5-vertical.test.mjs
COORDINATION_MIGRATION_CONTRACT_TEST := node ./app/test/migration-contract.test.mjs

.PHONY: help init up start stop down status verify config provider-check logs login uninstall test-agentteams test-agentteams-worker-admission-contract check-skills check-demo-contract check-phase6-evidence-bundle verify-professional-state build-worker-image build-coordination-image coordination-runtime-start coordination-runtime-status coordination-runtime-stop test-coordination-runtime-deployment test-leader-runtime-injection test-leader-runtime-injection-docker test-b5-role-runtime-injection-docker test-openclaw-migration-gate test-phase-c-contract phase-c-real test-worker-image-basic test-worker-image test-leader-smoke-contract test-leader-image-basic test-phase4-recovery test-b5-runtime-route test-b5-recovery test-b5-recovery-cli test-b5-vertical test-runner-isolation test-runner-executor test-runner-executor-linux test-runner-broker test-runner-broker-linux test-runner-preparation start-runner-broker status-runner-broker stop-runner-broker test-deployment-service test-peer-mention-smoke-contract test-peer-mention-smoke test-matrix-browser-smoke-contract matrix-browser-start matrix-browser-status matrix-browser-stop test-specialist-leader-handoff-contract test-specialist-leader-handoff test-p0-identity-pg-contract test-p0-2-mention-contract test-pause-worker-boundary test-openclaw-gate-a-contract test-openclaw-gate-a-fixture test-openclaw-admission-contract test-openclaw-admission-hooks test-openclaw-admission-replay test-openclaw-tool-result-capture-matrix test-openclaw-recovery test-openclaw-admission-context-file test-openclaw-gate-a-live-hooks test-runtime-console test-coordination-migration-contract openclaw-gate-a-start openclaw-gate-a-status openclaw-gate-a-restart openclaw-gate-a-stop openclaw-gate-a-run

.PHONY: start-coordination

help: ## Show available commands
	@printf '%s\n' 'Tiangong local development commands:'
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  make %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

init: ## Create a private .env from .env.example
	@$(AGENTTEAMS) init

up: ## Install or upgrade the pinned AgentTeams stack
	@$(AGENTTEAMS) up

start: ## Start existing AgentTeams containers
	@$(AGENTTEAMS) start

stop: ## Stop AgentTeams while preserving data
	@$(AGENTTEAMS) stop

down: stop ## Alias for stop

status: ## Show AgentTeams containers and endpoints
	@$(AGENTTEAMS) status

verify: ## Run local AgentTeams readiness checks
	@$(AGENTTEAMS) verify

config: ## Show effective configuration with secrets redacted
	@$(AGENTTEAMS) config

provider-check: ## Validate the provider/model route without changing the stack
	@$(AGENTTEAMS) provider-check

test-agentteams: ## Run the AgentTeams bootstrap and provider route contract tests
	@$(AGENTTEAMS_BOOTSTRAP_TEST)

test-agentteams-worker-admission-contract: ## Prove the AgentTeams agt boundary preserves credential scope fields
	@./scripts/test-agentteams-worker-admission.sh

logs: ## Follow logs; use SERVICE=controller for controller logs
	@$(AGENTTEAMS) logs $(SERVICE)

login: ## Show Element URL and local credential location
	@$(AGENTTEAMS) login

check-skills: ## Validate project Agent Skills and trigger cases
	@$(SKILL_CHECK)

check-demo-contract: ## Validate five-role, Skill, Playbook, and fixture demo contracts
	@node ./scripts/check-demo-contract.mjs

check-phase6-evidence-bundle: ## Verify safe-convergence acceptance and sanitized Phase 6 artifact digests
	@node ./scripts/check-phase6-evidence-bundle.mjs

verify-professional-state: ## Verify a preserved Project/Task/Result state (ROOT, PROJECT, EXPECTED required)
	@test -n "$(ROOT)" -a -n "$(PROJECT)" -a -n "$(EXPECTED)"
	@node ./scripts/verify-professional-state.mjs --root "$(ROOT)" --project "$(PROJECT)" --expected "$(EXPECTED)" $(foreach evidence,$(EVIDENCE),--evidence "$(evidence)")

build-worker-image: ## Build the pinned local Tiangong Worker image
	@$(WORKER_IMAGE_BUILD)

build-coordination-image: ## Build the deployment-owned PG/Matrix Coordination runtime image
	@$(COORDINATION_IMAGE_BUILD)

coordination-runtime-start: ## Start the deployment-owned Coordination runtime container
	@$(COORDINATION_RUNTIME_DEPLOY) start

coordination-runtime-status: ## Show the owned Coordination runtime container status
	@$(COORDINATION_RUNTIME_DEPLOY) status

coordination-runtime-stop: ## Stop and remove only the owned Coordination runtime container
	@$(COORDINATION_RUNTIME_DEPLOY) stop

test-coordination-runtime-deployment: ## Validate Coordination runtime image/lifecycle security contract
	@./scripts/test-coordination-runtime-deployment.sh

test-leader-runtime-injection: ## Validate the live Leader Worker binding/endpoint/token boundary
	@$(LEADER_RUNTIME_INJECTION_TEST)

test-leader-runtime-injection-docker: ## Validate the Docker Worker recreation/injection contract
	@$(LEADER_RUNTIME_DOCKER_INJECTION_TEST)

test-b5-role-runtime-injection-docker: ## Validate deployment-owned B5 role/runtime injection and rollback boundary
	@$(B5_ROLE_RUNTIME_INJECTION_TEST)

test-openclaw-migration-gate: ## Prove the new-Team OpenClaw default and explicit Pi rollback seam
	@./scripts/test-openclaw-migration-gate.sh

test-phase-c-contract: ## Run the deterministic Phase C production-boundary gate
	@./scripts/test-phase-c-production-boundary.sh

phase-c-real: ## Run the real, disposable AgentTeams Phase C/Gate B smoke (explicit opt-in)
	@TIANGONG_PHASE_C_REAL=1 ./scripts/test-phase-c-production-boundary.sh

test-worker-image-basic: ## Run the fast Matrix-to-pi Worker smoke and clean up
	@TIANGONG_WORKER_SMOKE_LEVEL=basic $(WORKER_IMAGE_TEST)

test-worker-image: ## Run the full Gate/approval/recovery Worker smoke and clean up
	@TIANGONG_WORKER_SMOKE_LEVEL=full $(WORKER_IMAGE_TEST)

test-leader-smoke-contract: ## Validate Leader smoke requester-report and in-container oracle semantics
	@$(LEADER_SMOKE_TEST)

test-leader-image-basic: ## Run the Leader Matrix coordination (blocked terminal partial) smoke and clean up
	@$(LEADER_SMOKE)

test-phase4-recovery: ## Run deterministic revision, rollback, recovery, and Leader restart regressions
	@$(PHASE4_RECOVERY_TEST)

test-b5-runtime-route: ## Prove the B5 role to OpenClaw/Codex runtime matrix
	@$(B5_RUNTIME_ROUTE_TEST)

test-b5-recovery: ## Prove B5 WorkRun ownership, restart uncertainty, and privileged recovery
	@$(B5_RECOVERY_TEST)

test-b5-recovery-cli: ## Prove the operator-only B5 WorkRun recovery entrypoint
	@$(B5_RECOVERY_CLI_TEST)

test-b5-vertical: ## Prove the deterministic B5 Leader/Implementor route and restart slice
	@$(B5_VERTICAL_TEST)

test-runner-isolation: ## Prove the disposable RunnerPort isolation contract and clean up
	@$(RUNNER_ISOLATION_SPIKE)

test-runner-executor: ## Run the production Docker executor against the isolation fixture
	@$(RUNNER_EXECUTOR_SMOKE)

test-runner-executor-linux: ## Run the Docker executor smoke inside a Linux control container
	@./scripts/run-runner-executor-linux.sh

test-runner-broker: ## Prove the closed container-identity Runner broker path
	@$(RUNNER_BROKER_SMOKE)

test-runner-broker-linux: ## Run the Runner broker and Work/Task/Result smoke inside Linux
	@./scripts/run-runner-broker-linux.sh

test-runner-preparation: ## Prove broker registration precedes fixed Worker plan access
	@$(RUNNER_PREPARATION_SMOKE)

start-runner-broker: ## Start the fixed shared Runner broker and preparation boundary
	@$(RUNNER_BROKER) start

status-runner-broker: ## Verify the fixed shared Runner broker boundary
	@$(RUNNER_BROKER) status

stop-runner-broker: ## Stop the shared Runner broker; use PURGE=1 to remove its state
	@$(RUNNER_BROKER) stop $(if $(PURGE),--purge,)

test-deployment-service: ## Prove the disposable deployment target state and authorization contract
	@$(DEPLOYMENT_SERVICE_SMOKE)

test-peer-mention-smoke-contract: ## Validate the Worker peer mention fixture and event oracle
	@$(PEER_MENTION_SMOKE_TEST)

test-peer-mention-smoke: ## Run the focused Worker peer mention smoke and clean up
	@$(PEER_MENTION_SMOKE)

test-matrix-browser-smoke-contract: ## Validate the dependency-free Matrix browser probe contract
	@$(MATRIX_BROWSER_SMOKE_TEST)

matrix-browser-start: ## Start the disposable Matrix browser probe and print its URL
	@$(MATRIX_BROWSER_SMOKE) start

matrix-browser-status: ## Show the bounded Matrix browser probe result
	@$(MATRIX_BROWSER_SMOKE) status

matrix-browser-stop: ## Stop the Matrix browser probe and verify exact cleanup
	@$(MATRIX_BROWSER_SMOKE) stop

test-specialist-leader-handoff-contract: ## Validate the exact Specialist-to-Leader handoff contract
	@$(SPECIALIST_HANDOFF_SMOKE_TEST)

test-specialist-leader-handoff: ## Run the focused Specialist-to-Leader handoff smoke and clean up
	@TIANGONG_RUN_REAL=1 $(SPECIALIST_HANDOFF_SMOKE_TEST)

test-p0-identity-pg-contract: ## Validate the P0.4 identity and PostgreSQL probe fixture contract
	@$(P0_IDENTITY_PG_CONTRACT)

test-p0-2-mention-contract: ## Validate the P0.2 mention-gating and delivery probe contract
	@$(P0_MENTION_DELIVERY)

test-pause-worker-boundary: ## Test the bounded paused-Worker smoke orchestration guard
	@$(PAUSE_WORKER_BOUNDARY_TEST)

test-openclaw-gate-a-contract: ## Validate the deterministic OpenClaw Gate A preflight contract
	@./scripts/test-openclaw-gate-a.sh

test-openclaw-gate-a-fixture: ## Validate the isolated OpenClaw Gate A image and Worker fixture
	@./scripts/test-openclaw-gate-a-fixture.sh

test-openclaw-admission-contract: ## Validate the two-stage OpenClaw admission boundary
	@node ./worker/test/admission-boundary.test.mjs

test-openclaw-admission-hooks: ## Validate the OpenClaw hook registration and fail-closed decisions
	@node ./worker/test/admission-hooks.test.mjs

test-openclaw-admission-replay: ## Validate deterministic allow, deny, revocation, and replay admission paths
	@node ./worker/test/admission-replay.test.mjs

test-openclaw-tool-result-capture-matrix: ## Validate bounded success, error, denial, and replay ToolResult capture
	@node ./worker/test/tool-result-capture.test.mjs ./worker/test/tool-result-capture-matrix.test.mjs

test-openclaw-recovery: ## Validate one durable Runner owner and completed-result replay after reopen
	@node ./worker/test/openclaw-recovery.test.mjs

test-openclaw-admission-context-file: ## Validate the bounded file-backed admission context provider
	@node ./worker/test/admission-context-file.test.mjs ./worker/test/admission-context.test.mjs ./worker/test/canary-admission.test.mjs

test-openclaw-gate-a-live-hooks: ## Inspect the hooks registered by the running pinned canary
	@./scripts/test-openclaw-gate-a-live-hooks.sh

test-runtime-console: ## Validate the read-only Web runtime console shell
	@node --test app/test/*.test.mjs

test-coordination-migration-contract: ## Validate the digest-bound provider and Work/Task/Result migration contract
	@$(COORDINATION_MIGRATION_CONTRACT_TEST)

start-coordination: ## Start the deployment-owned PG Coordination API and Matrix outbox consumer
	@npm --prefix app run start-coordination

openclaw-gate-a-start: ## Create the isolated OpenClaw Gate A Worker (TIANGONG_RUN_REAL=1)
	@./smoke-testing/support/run-openclaw-gate-a.sh start

openclaw-gate-a-status: ## Inspect the isolated OpenClaw Gate A Worker
	@./smoke-testing/support/run-openclaw-gate-a.sh status

openclaw-gate-a-restart: ## Restart the isolated canary and verify readiness recovery
	@./smoke-testing/support/run-openclaw-gate-a.sh restart

openclaw-gate-a-stop: ## Delete only the owned OpenClaw Gate A Worker and verify cleanup
	@./smoke-testing/support/run-openclaw-gate-a.sh stop

openclaw-gate-a-run: ## Run the isolated OpenClaw Gate A preflight/readiness canary
	@./smoke-testing/support/run-openclaw-gate-a.sh run

uninstall: ## Delete local AgentTeams data; requires CONFIRM=delete-tiangong-agentteams-data
	@CONFIRM="$(CONFIRM)" $(AGENTTEAMS) uninstall
