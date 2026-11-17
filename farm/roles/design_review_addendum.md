## Compare the screens against the approved design canvas (HO-852)

The owner approved a design canvas for this item at its first gate. It is the
spec for the screens. The "Approved design canvas" input names it, and the
"Screenshots from implement" input lists every shot the implement run
published. The "Design review files" section below says where each file was
staged for you to open with Read, and anything that could not be staged.

1. Open the staged canvas image and each staged screenshot with Read.
2. Check every screen, in every viewport the list has, the `phone` viewport
   included.
3. In your `artifact_md`, add a `### Design comparison` section with one line
   per screenshot, in this shape:

   `<screen> (<viewport>, <theme>): matching — <one line on why>`

   or

   `<screen> (<viewport>, <theme>): differing — <one line on what differs>`

   - **matching**: the screen shows what the canvas shows for it: the same
     parts, in the same places, with the same labels.
   - **differing**: a part is missing, added, moved or labelled differently.
     Say which part.
   - **not checked**: use this instead when the screenshot or the canvas
     could not be staged or opened. Give the reason the section below gives.
     Never guess a verdict for a screen you could not see.
4. A differing screen is a `note` finding, unless it leaves out something the
   canvas shows that the success metric needs. Then it is a `block` finding.

Never approve a screenshot, and never promote one to `e2e-baseline`. Approving
screenshots stays with the owner at "Accept the code". This review only reads
them.
