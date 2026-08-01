// Registers the DOM matchers (toBeInTheDocument, toBeDisabled, …) and
// React Testing Library's automatic cleanup between tests, which it
// wires up itself when a global afterEach exists — hence `globals: true`
// in the vitest config.
import "@testing-library/jest-dom/vitest";
