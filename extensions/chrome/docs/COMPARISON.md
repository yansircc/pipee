# Comparison

`pi-chrome` is a transport for controlling an existing local Chrome profile. It is not a hosted browser, an agent framework, or OS automation.

| Property                   | pi-chrome                            | Playwright/Puppeteer      | Hosted browser          |
| -------------------------- | ------------------------------------ | ------------------------- | ----------------------- |
| Existing signed-in profile | Native                               | Usually separate profile  | Remote profile          |
| Runtime location           | Local Chrome extension               | Local browser process     | Provider infrastructure |
| Public agent surface       | Three typed Pi tools                 | Library API               | Provider API            |
| Input                      | Chrome debugger/CDP                  | CDP                       | Provider-dependent      |
| Page observation           | Snapshot, evaluate, console, network | DOM/CDP                   | Provider-dependent      |
| Implicit target isolation  | Per Pi session                       | Caller-owned context/page | Provider session        |
| Native OS control          | No                                   | No                        | No                      |

Choose `pi-chrome` when authenticated state already exists in the user's Chrome profile and the agent should work through that exact browser. Choose Playwright/Puppeteer when you own browser startup and need deterministic test contexts. Choose a hosted browser when remote execution, scaling, or managed sessions are the primary requirement.

The security tradeoff follows the same boundary: `pi-chrome` installs broad permissions into a real local profile, while isolated or hosted browsers keep automation state separate from that profile.
