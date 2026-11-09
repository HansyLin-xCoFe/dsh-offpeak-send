/**
 * dsh-offpeak-send — Host half.
 *
 * All work happens in the browser: the client module (client.js) renders a
 * clock control to the left of the composer submit action, lets the user pick
 * a send time, and creates a one-shot Host Schedule task through the shipped
 * `schedule` service's Remote namespace. The Host `schedule` service then
 * delivers the draft into the current Session inbox at that instant, even if
 * this page is closed.
 *
 * This half registers nothing and exposes no routes.
 */
export function apply() {}
