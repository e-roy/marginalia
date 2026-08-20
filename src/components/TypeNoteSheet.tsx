import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { createTextNote, type NoteTarget } from '@/lib/notes'

interface TypeNoteSheetProps {
  uid: string
  target: NoteTarget
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The `⌨ type instead` half of capture (SPEC §8). A typed note skips Storage, the
 * function and the whole cleanup pipeline — it is saved exactly as written and is
 * `done` on arrival.
 */
export function TypeNoteSheet({ uid, target, open, onOpenChange }: TypeNoteSheetProps) {
  const [text, setText] = useState('')

  const close = () => {
    onOpenChange(false)
    setText('')
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (text.trim().length === 0) return
    createTextNote(uid, text, target)
    close()
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        // Deliberately discarded on dismiss: this is a scratch surface, and a draft
        // that silently reappears later is more confusing than one that doesn't.
        if (!next) setText('')
      }}
    >
      <SheetContent side="bottom" className="max-h-[85dvh]">
        <SheetHeader>
          <SheetTitle>Type a note</SheetTitle>
          <SheetDescription>
            {target.title}
            {target.chapter === null ? ' · Unfiled' : ` · Chapter ${target.chapter}`}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={submit} className="flex flex-col gap-4 px-4 pb-4">
          <Textarea
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="What are you thinking?"
            aria-label="Note text"
            rows={6}
            className="resize-none text-base"
          />

          <SheetFooter className="flex-row gap-2 px-0">
            <Button type="button" variant="ghost" onClick={close} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" disabled={text.trim().length === 0} className="flex-1">
              Save note
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
