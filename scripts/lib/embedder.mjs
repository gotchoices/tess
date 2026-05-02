/**
 * Local embedding via @huggingface/transformers (transformers.js).
 *
 * Default model: Xenova/all-MiniLM-L6-v2 (384-dim, ~80MB).  First run
 * downloads weights to TRANSFORMERS_CACHE (we point this at
 * tickets/.index/models/ so all artifacts stay under the project).
 *
 * Usage:
 *   const embedder = await Embedder.load(modelDir);
 *   const vectors = await embedder.embed(['text1', 'text2']);   // Float32Array[]
 */

export const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const DEFAULT_DIM = 384;
const BATCH_SIZE = 32;

export class Embedder {
	constructor(pipeline, modelId) {
		this.pipeline = pipeline;
		this.modelId = modelId;
	}

	static async load(cacheDir, modelId = DEFAULT_MODEL) {
		// Point transformers.js at our local cache before importing it so the
		// env settings take effect on first load.
		process.env.TRANSFORMERS_CACHE = cacheDir;
		const transformers = await import('@huggingface/transformers');
		transformers.env.cacheDir = cacheDir;
		transformers.env.allowLocalModels = true;
		// Suppress the "ONNX Runtime: …" startup banner on stderr that some
		// MCP clients flag as noise.
		transformers.env.backends?.onnx?.wasm && (transformers.env.backends.onnx.wasm.proxy = false);

		const pipeline = await transformers.pipeline('feature-extraction', modelId, {
			quantized: true,
		});
		return new Embedder(pipeline, modelId);
	}

	async embedOne(text) {
		const out = await this.pipeline(text, { pooling: 'mean', normalize: true });
		return new Float32Array(out.data);
	}

	/**
	 * Embed an array of strings; returns Float32Array[] in input order.
	 * Batched internally to amortize model overhead.
	 */
	async embed(texts) {
		const result = new Array(texts.length);
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			const batch = texts.slice(i, i + BATCH_SIZE);
			const out = await this.pipeline(batch, { pooling: 'mean', normalize: true });
			// transformers returns a single Tensor of shape [batch, dim]; slice it.
			const dim = out.dims[1];
			const flat = out.data;
			for (let j = 0; j < batch.length; j++) {
				const v = new Float32Array(dim);
				for (let k = 0; k < dim; k++) v[k] = flat[j * dim + k];
				result[i + j] = v;
			}
		}
		return result;
	}
}
