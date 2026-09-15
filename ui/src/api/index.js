// Data-layer switch: the server API is the default; set VITE_MOCK=1 to run
// the UI standalone on the in-browser mock (no server needed).

import * as mock from './mockApi'
import * as server from './serverApi'

const impl = import.meta.env.VITE_MOCK === '1' ? mock : server

export const {
  subscribe,
  getItems,
  getSync,
  getCurrentUser,
  login,
  logout,
  googleLoginUrl,
  regenerateGatePin,
  getProjects,
  getActiveProjectId,
  getFarm,
  activateProject,
  saveToken,
  createProject,
  addRepoToProject,
  disconnectRepo,
  createItem,
  artifactUrl,
  outputUrl,
  runLogViewUrl,
  issueUrl,
  issueLabel,
  approveGate,
  requestChanges,
  togglePause,
  restartPhase,
  setPersona,
  listDefinitions,
  getDefinition,
  saveDefinition,
  effectivePrompt,
  getDeployTargets,
} = impl
