# Swipe reply browser evidence

Source `0d186ade640af75bcb178df01edb733171ec0b56`. [Completed native browser run](https://github.com/leonongoing/OpenMausBot/actions/runs/42884218366). Synthetic disposable chat and room; no real account.

Before: original upstream ChatView, GroupView and MessageActions bytes. After: exact public source commit. Four native touch cases cover person/bot messages in chat/room and real composer sends whose saved replyToId matches the swiped message.

Videos encode actual CDP screencast frames with their original timestamps. Chrome mobile emulation is not physical Android. Full pnpm test is a separate pending check.
