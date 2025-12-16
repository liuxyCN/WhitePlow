import { memo, type ReactNode, useState } from "react"
import { Trans } from "react-i18next"
import { SiDiscord, SiReddit, SiX } from "react-icons/si"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import { Package } from "@roo/package"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@src/components/ui"

interface AnnouncementProps {
	hideAnnouncement: () => void
}

/**
 * You must update the `latestAnnouncementId` in ClineProvider for new
 * announcements to show to users. This new id will be compared with what's in
 * state for the 'last announcement shown', and if it's different then the
 * announcement will render. As soon as an announcement is shown, the id will be
 * updated in state. This ensures that announcements are not shown more than
 * once, even if the user doesn't close it themselves.
 */

const Announcement = ({ hideAnnouncement }: AnnouncementProps) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(true)

	return (
		<Dialog
			open={open}
			onOpenChange={(open) => {
				setOpen(open)

				if (!open) {
					hideAnnouncement()
				}
			}}>
			<DialogContent className="max-w-96">
				<DialogHeader>
					<DialogTitle>{t("chat:announcement.title", { version: Package.version })}</DialogTitle>
				</DialogHeader>
				<div>

				</div>
			</DialogContent>
		</Dialog>
	)
}

const SocialLink = ({ icon, label, href }: { icon: ReactNode; label: string; href: string }) => (
	<VSCodeLink
		href={href}
		className="inline-flex items-center gap-1"
		onClick={(e) => {
			e.preventDefault()
			vscode.postMessage({ type: "openExternal", url: href })
		}}>
		{icon}
		<span className="sr-only">{label}</span>
	</VSCodeLink>
)

const GitHubLink = ({ children }: { children?: ReactNode }) => (
	<VSCodeLink
		href="https://ai.chinalifepe.com"
		onClick={(e) => {
			e.preventDefault()
			vscode.postMessage({ type: "openExternal", url: "https://ai.chinalifepe.com" })
		}}>
		{children}
	</VSCodeLink>
)

const CareersLink = ({ children }: { children?: ReactNode }) => (
	<VSCodeLink
		href="https://ai.chinalifepe.com"
		onClick={(e) => {
			e.preventDefault()
			vscode.postMessage({ type: "openExternal", url: "https://ai.chinalifepe.com" })
		}}>
		{children}
	</VSCodeLink>
)

export default memo(Announcement)
