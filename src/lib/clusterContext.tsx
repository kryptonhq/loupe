import { createContext, useContext } from "react";
import type { Guard } from "./api";

// Which cluster the app is pointed at, and what it allows.
//
// A React context rather than a prop threaded through every page,
// because every write path needs it and none of the intermediate
// components have any business knowing about it. The guard in
// particular has to reach the editor: a read-only context should not
// offer an Edit button at all.

export interface ClusterScope {
  /// The connected context's name, or null before anything is connected.
  context: string | null;
  /// What that context allows. `open` until told otherwise, so a failure
  /// to read preferences never silently locks the user out of writing.
  guard: Guard;
}

export const ClusterContext = createContext<ClusterScope>({
  context: null,
  guard: "open",
});

export function useCluster(): ClusterScope {
  return useContext(ClusterContext);
}
