### Design Rationale

Aibleton is designed in two main pieces: the ui, and the server.

The ui a simple nextjs application that hits an API on the server. The main point of the ui is to let users communicate with the server and understand high level song structure, as well as the agent's song choices. It is not intended to replace a DAW like Ableton.

The server has a little more to it. It is intended to act as an interface for the Ableton and Splice MCPs, make live choices about song and band structure, and provide an API for external systems (including the ui) to view state and provide input into the choices being made.

One important detail of the system is that it needs the ability to demonstrate functionality without necessarily having access to either splice or ableton (or anthropic). This is where the three main abstractions come into play:

- brain
- library
- daw

The other nice thing about modularization is that then agents can build them in parallel.

The library abstracts away splice and the daw abstracts away ableton. This means that the UI, for example, may operate without necessarily having either.

The brain abstracts the anthropic API. This means we can do loads of work on the system without ever touching an LLM. Inside of the brain, it runs a simple agent loop: observe, decide, act. Right now this agent loop doesn't do much, but the intent is that we'll be able to use the API to add input to this loop.

LLM invocations take awhile, this is why the loop doesn't try to do things in real time. Instead, it has a mailbox that inputs are added to, and a simple interval on which it checks the mailbox. This is a reliable way to get the agent loop to respond to various asynchronous inputs. In the future, this would allow MIDI control surfaces (like footpedals) or realtime audio plugins in the DAW to provide information to the agent loop.

