import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Annotations, PairChips } from "./Field";

// Annotations are the one place in these panes where a value has no
// bound on its length. `kubectl apply` writes the entire object into
// `last-applied-configuration`, and rendering that the way a label is
// rendered pushes a horizontal scrollbar across the whole window.

const LAST_APPLIED =
  '{"apiVersion":"krypton.ai/v1alpha1","kind":"Agent","metadata":{"annotations":{},"name":"mcp-hello","namespace":"agents"},"spec":{"mode":"always-on","replicas":1,"model":"qwen2-0-5b","resources":{"limits":{"cpu":"1","memory":"1Gi"},"requests":{"cpu":"100m","memory":"256Mi"}},"tools":["search","fetch"]}}';

describe("Annotations", () => {
  it("folds a long value away and offers to show it", async () => {
    const user = userEvent.setup();
    render(<Annotations pairs={[["kubectl.kubernetes.io/last-applied-configuration", LAST_APPLIED]]} />);

    const more = screen.getByRole("button", { name: "Show more" });
    await user.click(more);
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });

  it("shows a short value outright, with nothing to expand", () => {
    // A toggle over two words is noise.
    render(<Annotations pairs={[["deployment.kubernetes.io/revision", "3"]]} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("never lets a value hold the line open", () => {
    // The actual bug: serialised JSON has no spaces, so a word-boundary
    // wrap finds nowhere to break and the line runs off the side of the
    // window. `break-all` is what makes it wrap at all.
    render(<Annotations pairs={[["a", LAST_APPLIED]]} />);
    const value = screen.getByText(LAST_APPLIED);
    expect(value).toHaveClass("break-all");
    expect(value).not.toHaveClass("whitespace-nowrap");
  });

  it("wraps the key too, since those get long as well", () => {
    const key = "kubectl.kubernetes.io/last-applied-configuration";
    render(<Annotations pairs={[[key, "x"]]} />);
    expect(screen.getByText(key)).toHaveClass("break-all");
  });

  it("renders nothing at all when there are no annotations", () => {
    // Not an empty heading over an empty list.
    const { container } = render(<Annotations pairs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("PairChips", () => {
  it("keeps short pairs on one line each", () => {
    // Labels are capped at 63 characters by Kubernetes, which is what
    // makes a non-wrapping chip safe here and unsafe for annotations.
    render(<PairChips title="Labels" pairs={[["app", "coredns"]]} />);
    expect(screen.getByText("app=coredns")).toHaveClass("whitespace-nowrap");
  });
});
