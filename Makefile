SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

AGENTTEAMS := ./scripts/agentteams.sh
AGENTTEAMS_BOOTSTRAP_TEST := ./scripts/test-agentteams.sh
WORKER_IMAGE_BUILD := ./scripts/build-worker-image.sh
COORDINATION_IMAGE_BUILD := ./scripts/build-coordination-image.sh
COORDINATION_RUNTIME_DEPLOY := ./scripts/deploy-coordination-runtime.sh
AGENTLOOP_COLLECTOR := ./scripts/agentloop-collector.sh
LEADER_RUNTIME_INJECTION_TEST := ./scripts/test-leader-runtime-injection.sh
LEADER_RUNTIME_DOCKER_INJECTION_TEST := ./scripts/test-leader-runtime-injection-docker.sh
MEMBER_RUNTIME_INJECTION_TEST := ./scripts/test-member-runtime-injection-docker.sh
PEER_MENTION_SMOKE := ./smoke-testing/support/run-peer-mention-smoke.sh
PEER_MENTION_SMOKE_TEST := ./scripts/test-peer-mention-smoke.sh
MATRIX_BROWSER_SMOKE := ./smoke-testing/support/run-matrix-browser-smoke.sh
MATRIX_BROWSER_SMOKE_TEST := ./scripts/test-matrix-browser-smoke.sh
SPECIALIST_HANDOFF_SMOKE := ./smoke-testing/support/run-specialist-leader-handoff.sh
P0_IDENTITY_PG_CONTRACT := ./scripts/test-p0-identity-pg.sh
P0_MENTION_DELIVERY := ./scripts/test-p0-2-mention.sh
SPECIALIST_HANDOFF_SMOKE_TEST := ./scripts/test-specialist-leader-handoff.sh
SKILL_CHECK := node ./scripts/check-skills.mjs
PRODUCT_AGENT_SKILL_TEST := node --test ./worker/test/agent-packages.test.mjs ./worker/test/product-skills.test.mjs ./worker/test/skill-runtime.test.mjs ./app/test/server.test.mjs
CHAT_FIRST_WEB_TEST := node --test --test-concurrency=1 ./app/test/matrix-web-gateway.test.mjs ./app/test/server.test.mjs ./app/test/runtime-server.test.mjs
B5_RUNTIME_ROUTE_TEST := node ./worker/test/runtime-routing.test.mjs

.PHONY: help init up start stop down status verify config provider-check logs login uninstall test-agentteams test-agentteams-worker-admission-contract check-skills test-product-agent-skills test-chat-first-web check-demo-contract build-worker-image build-coordination-image coordination-runtime-start coordination-runtime-status coordination-runtime-stop test-coordination-runtime-deployment agentloop-collector-start agentloop-collector-status agentloop-collector-stop test-agentloop-contract test-leader-runtime-injection test-leader-runtime-injection-docker test-member-runtime-injection-docker test-b5-runtime-route test-peer-mention-smoke-contract test-peer-mention-smoke test-matrix-browser-smoke-contract matrix-browser-start matrix-browser-status matrix-browser-stop test-specialist-leader-handoff-contract test-specialist-leader-handoff test-p0-identity-pg-contract test-p0-2-mention-contract test-pause-worker-boundary test-openclaw-admission-contract test-openclaw-admission-hooks test-openclaw-admission-replay test-openclaw-tool-result-capture-matrix test-openclaw-admission-context-file test-runtime-console

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

check-skills: ## Validate maintainer/product Skills and Agent package locks
	@$(SKILL_CHECK)

test-product-agent-skills: ## Prove M1/M2 package, session, Skill selection, and visible usage contracts
	@$(PRODUCT_AGENT_SKILL_TEST)
	@bash ./scripts/test-member-runtime-injection-docker.sh

test-chat-first-web: ## Prove M3 Matrix session, chat, revocation, and Work projection contracts
	@$(CHAT_FIRST_WEB_TEST)

check-demo-contract: ## Validate six Agent packages, product Skills, and generic Worker fixtures
	@node ./scripts/check-demo-contract.mjs

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

agentloop-collector-start: ## Start the credential-isolating AgentLoop collector
	@$(AGENTLOOP_COLLECTOR) start

agentloop-collector-status: ## Show the owned AgentLoop collector status
	@$(AGENTLOOP_COLLECTOR) status

agentloop-collector-stop: ## Remove only the owned AgentLoop collector
	@$(AGENTLOOP_COLLECTOR) stop

test-agentloop-contract: ## Validate AgentLoop credential, OTLP, and correlation boundaries
	@node --test ./test/agentloop-deployment.test.mjs ./worker/test/agentloop-correlation.test.mjs

test-leader-runtime-injection: ## Validate the live Leader Worker binding/endpoint/token boundary
	@$(LEADER_RUNTIME_INJECTION_TEST)

test-leader-runtime-injection-docker: ## Validate the Docker Worker recreation/injection contract
	@$(LEADER_RUNTIME_DOCKER_INJECTION_TEST)

test-member-runtime-injection-docker: ## Validate MemberConfig runtime/model injection into generic tg-worker
	@bash $(MEMBER_RUNTIME_INJECTION_TEST)

test-b5-runtime-route: ## Prove the B5 role to OpenClaw/Codex runtime matrix
	@$(B5_RUNTIME_ROUTE_TEST)

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

test-openclaw-admission-contract: ## Validate the two-stage OpenClaw admission boundary
	@node ./worker/test/admission-boundary.test.mjs

test-openclaw-admission-hooks: ## Validate the OpenClaw hook registration and fail-closed decisions
	@node ./worker/test/admission-hooks.test.mjs

test-openclaw-admission-replay: ## Validate deterministic allow, deny, revocation, and replay admission paths
	@node ./worker/test/admission-replay.test.mjs

test-openclaw-tool-result-capture-matrix: ## Validate bounded success, error, denial, and replay ToolResult capture
	@node ./worker/test/tool-result-capture.test.mjs ./worker/test/tool-result-capture-matrix.test.mjs

test-openclaw-admission-context-file: ## Validate the bounded file-backed admission context provider
	@node ./worker/test/admission-context-file.test.mjs ./worker/test/admission-context.test.mjs ./worker/test/canary-admission.test.mjs

test-runtime-console: ## Validate the read-only Web runtime console shell
	@node --test app/test/*.test.mjs

start-coordination: ## Start the deployment-owned PG Coordination API and Matrix outbox consumer
	@npm --prefix app run start-coordination

uninstall: ## Delete local AgentTeams data; requires CONFIRM=delete-tiangong-agentteams-data
	@CONFIRM="$(CONFIRM)" $(AGENTTEAMS) uninstall
