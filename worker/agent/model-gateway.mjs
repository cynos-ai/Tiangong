import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { sanitizedProviderConfiguration } from "./model-provider-config.mjs";

const RUNTIME_DIRECTORY_PREFIX = "tiangong-model-gateway-";

export class ModelGateway {
  #configPath;
  #provider;
  #directory;
  #runtime;

  constructor({ configPath, provider }) {
    this.#configPath = configPath;
    this.#provider = provider;
  }

  async initialize() {
    if (this.#runtime) return;
    const workerConfig = JSON.parse(await readFile(this.#configPath, "utf8"));
    const configuration = sanitizedProviderConfiguration(workerConfig, this.#provider);
    this.#directory = await mkdtemp(join(tmpdir(), RUNTIME_DIRECTORY_PREFIX));
    const modelsPath = join(this.#directory, "models.json");
    await writeFile(modelsPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
    this.#runtime = await ModelRuntime.create({
      authPath: join(this.#directory, "auth.json"),
      modelsPath,
    });
  }

  async resolve({ provider, modelId, credential }) {
    if (provider !== this.#provider) throw new Error(`Unsupported model provider: ${provider}`);
    if (typeof credential !== "string" || credential === "") {
      throw new Error("A resolved Worker gateway credential is required");
    }
    await this.initialize();
    this.#runtime.setRuntimeApiKey(provider, credential);
    const model = this.#runtime.getModel(provider, modelId);
    if (!model) throw new Error(`pi model is unavailable: ${provider}/${modelId}`);
    return { model, modelRuntime: this.#runtime };
  }

  async dispose() {
    if (this.#directory) await rm(this.#directory, { recursive: true, force: true });
    this.#directory = undefined;
    this.#runtime = undefined;
  }
}
