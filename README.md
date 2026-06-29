# What

Before: Using many agents to try to get your work done. They forget things. They don't respect your rules of the road. You spend time fixing the damage they do, whilst debating if AI is actually making you faster.

After: A well-defined software development lifecycle with explicit gates that cannot be broken (e.g. testing is a MUST). This development lifecycle is accessible by non-engineers who can create work for the bot farm, whilst an engineer oversees the agents to ensure high quality and rapid build-out.

# The Development Lifecycle

* Plan
  *  A concise description of the outcome
  *  How dow e measusre success
  *  Guardrails, beyond the default ones below
  *  [HUMAN GATE] Approve and prioritize this work
* Technical Plan
  * An ensemble of PM / QA / Architect agents plan the technical work creatings pros/cons of various options
  * [HUMAN GATE] Approve the high level design
  * Eng agents create technical plans of how they will implement (e.g. which codebases to touch, rough outline of the work to be done, testing impact, etc)
  * Architecture agents reviews plans (e.g. code cleaniless, etc)
  * QA agent reviews if the test plan is sufficient
  * [Optional: Human gate] Review before execution
* Execute
  * Eng Agents with specific knowledge of relevant
  * Pass the work off to an agent with specific expertise in the area of work
  * [HUMAN GATE] Accept the code
* Deploy
  * DevOps agent depoys the changes 
* Review
  * [HUMAN GATE] Review the work before closing the task 

# The Non-Negotiable Checkpoints

* Deterministic Guardrails: A set of tasks to run that must pass in order to proceed
  * Unit tests
  * Integration tests
  * Data Quality tests
  * Performance tests
  * Code linters
  * End-to-end tests inc. UI
* Non-deterministic Guardrails: Run by agents
  * Code duplication
  * Code Encapsulation
  * Code cleanliness
 
# Customizatable Checkpoints

Ability to add additional human steps where necessary
