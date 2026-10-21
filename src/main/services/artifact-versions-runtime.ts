import { dataPath } from './paths'
import { ArtifactVersionStore } from './artifact-versions'

let store: ArtifactVersionStore | null = null

export function getArtifactVersionStore(): ArtifactVersionStore {
  if (!store) store = new ArtifactVersionStore({ dir: dataPath('artifact-versions') })
  return store
}
