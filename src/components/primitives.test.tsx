import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chip, ChipList, eventTone } from "./Chip";
import { StatusDot, phaseTone } from "./StatusDot";
import { Select } from "./Select";
import { Panel, ErrorStrip } from "./Panel";
import { YamlView } from "./YamlView";

// The small shared pieces. Most of what is worth pinning here is the
// mapping from a Kubernetes value to a colour, because those are the
// judgements a reader trusts without checking.

describe("phaseTone", () => {
  it("does not colour a finished pod as healthy", () => {
    // A Succeeded Job pod is finished, not healthy. Green would say a
    // completed batch job is still doing its work.
    expect(phaseTone("Succeeded")).toBe("unknown");
    expect(phaseTone("Running")).toBe("ok");
    expect(phaseTone("Pending")).toBe("warn");
    expect(phaseTone("Failed")).toBe("danger");
  });

  it("leaves a phase it does not know about uncoloured", () => {
    // The API can grow phases. Guessing would eventually colour a real
    // problem green.
    expect(phaseTone("Terminating")).toBe("unknown");
    expect(phaseTone("")).toBe("unknown");
  });
});

describe("eventTone", () => {
  it("maps the closed set Kubernetes actually uses", () => {
    expect(eventTone("Normal")).toBe("ok");
    expect(eventTone("Warning")).toBe("warn");
    expect(eventTone("Error")).toBe("danger");
  });

  it("stays neutral for anything else", () => {
    expect(eventTone("Informational")).toBe("neutral");
  });
});

describe("StatusDot", () => {
  it("always shows the label beside the dot", () => {
    // Colour alone fails for anyone with a colour-vision deficiency, so
    // the dot never replaces the word.
    render(<StatusDot tone="danger" label="Failed" />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});

describe("ChipList", () => {
  it("renders one chip per value", () => {
    // A comma-separated string reads as one blob; chips read as N things.
    render(<ChipList values={["control-plane", "etcd", "master"]} />);
    expect(screen.getByText("control-plane")).toBeInTheDocument();
    expect(screen.getByText("etcd")).toBeInTheDocument();
    expect(screen.getByText("master")).toBeInTheDocument();
  });

  it("renders an em dash rather than nothing when empty", () => {
    // An empty cell reads as a rendering failure.
    render(<ChipList values={[]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("carries a title through for a truncated value", () => {
    render(<Chip title="the full value">short</Chip>);
    expect(screen.getByTitle("the full value")).toBeInTheDocument();
  });
});

describe("Select", () => {
  it("reports the chosen value", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Select value="app" onChange={onChange}>
        <option value="app">app</option>
        <option value="sidecar">sidecar</option>
      </Select>,
    );

    await user.selectOptions(screen.getByRole("combobox"), "sidecar");
    expect(onChange).toHaveBeenCalledWith("sidecar");
  });
});

describe("ErrorStrip", () => {
  it("announces itself to a screen reader", () => {
    render(<ErrorStrip error={{ kind: "kubernetes", message: "boom" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });

  it("renders a plain Error as its message", () => {
    render(<ErrorStrip error={new Error("network unreachable")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("network unreachable");
  });
});

describe("Panel", () => {
  it("shows its title and body", () => {
    render(
      <Panel title="Pods" subtitle="kube-system">
        <p>body</p>
      </Panel>,
    );
    expect(screen.getByRole("heading", { name: "Pods" })).toBeInTheDocument();
    expect(screen.getByText("kube-system")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("offers Refresh only when there is something to refresh", async () => {
    const onRefresh = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Panel title="Pods">body</Panel>);
    expect(
      screen.queryByRole("button", { name: "Refresh" }),
    ).not.toBeInTheDocument();

    rerender(
      <Panel title="Pods" onRefresh={onRefresh}>
        body
      </Panel>,
    );
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("shows a quiet indicator during a refetch rather than blanking", () => {
    // Replacing a populated table with grey bars every few seconds is
    // worse than a slightly stale number.
    render(
      <Panel title="Pods" isFetching>
        <p>existing rows</p>
      </Panel>,
    );
    expect(screen.getByText("refreshing")).toBeInTheDocument();
    expect(screen.getByText("existing rows")).toBeInTheDocument();
  });

  it("surfaces an error above the body", () => {
    render(
      <Panel title="Pods" error={{ kind: "not_connected", message: "no cluster" }}>
        body
      </Panel>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("no cluster");
  });
});

describe("YamlView", () => {
  it("numbers every line", () => {
    render(<YamlView source={"apiVersion: v1\nkind: Pod\nmetadata:\n"} />);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("copies the source rather than what is rendered", async () => {
    // The pane interleaves line numbers with the text. Copying that
    // would produce YAML nobody can apply.
    const source = "apiVersion: v1\nkind: Pod\n";
    const user = userEvent.setup();

    // After `setup()`, which installs a clipboard stub of its own, and
    // via defineProperty because jsdom exposes it as a getter.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<YamlView source={source} />);

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(source);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument(),
    );
  });
});
