import express from 'express';

let runtime;
/** Mount the loopback-only bridge before the general API body parser. */
export function localSceneRoutes(root) {
  const router = express.Router();
  router.use((req, res, next) => {
    // Reject DNS rebinding and cross-site requests, including simple/no-CORS requests.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.get('host') || '') || req.get('sec-fetch-site') === 'cross-site')
      return res.status(403).json({ error: 'Use the local workbench origin.' });
    next();
  });
  router.use(express.json({ limit: '75mb', type: 'application/json' }));
  const handle = operation => async (req, res) => {
    try {
      runtime ??= import('tsx/esm/api').then(({ tsImport }) => tsImport('./local-scene-api.ts', import.meta.url));
      const { localSceneRequest } = await runtime;
      res.json(await localSceneRequest(root, req.params.id, operation, req.query.revision, req.body));
    } catch (error) {
      const status = { DISABLED: 503, CONFLICT: 409, REQUEST_ID_REUSED: 409, SCENE_UNAVAILABLE: 404, PAYLOAD_TOO_LARGE: 413 }[error.code] || 400;
      res.status(status).json({ error: error.message || 'Local scene request failed.', code: error.code || 'INVALID_REQUEST', ...error.details });
    }
  };
  router.get('/:id/head', handle('head'));
  router.get('/:id', handle('read'));
  router.post('/:id/commit', handle('commit'));
  return router;
}
