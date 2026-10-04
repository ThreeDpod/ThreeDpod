/** The faces of the workbench. Named once, so the tab and its panel cannot drift apart. */
export type WorkbenchTab = "preview" | "code" | "model";

export const WORKBENCH_TABS: readonly { id: WorkbenchTab; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "code", label: "Code" },
  { id: "model", label: "3D Model" },
];
