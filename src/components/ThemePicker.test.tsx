import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemePicker } from "./ThemePicker";

describe("ThemePicker", () => {
  it("offers the three modes and marks the current one", () => {
    render(<ThemePicker theme="dark" onChange={vi.fn()} />);

    const options = screen.getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "System" })).not.toBeChecked();
  });

  it("reports the mode that was clicked", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ThemePicker theme="system" onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(onChange).toHaveBeenCalledWith("light");
  });

  it("is a labelled group, so it reads as one control", () => {
    // Three loose buttons announce as three unrelated controls; a
    // radiogroup announces as one choice with three options.
    render(<ThemePicker theme="system" onChange={vi.fn()} />);
    expect(
      screen.getByRole("radiogroup", { name: "Appearance" }),
    ).toBeInTheDocument();
  });
});
