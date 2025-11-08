import { useState } from "react"

const RooHero = () => {
	const [imagesBaseUri] = useState(() => {
		const w = window as any
		return w.IMAGES_BASE_URI || ""
	})

	return (
		<div className="pb-4 forced-color-adjust-none group flex justify-center">
			<div
				style={{
					backgroundColor: "var(--vscode-foreground)",
					WebkitMaskImage: `url('${imagesBaseUri}/neontractor-logo.png')`,
					WebkitMaskRepeat: "no-repeat",
					WebkitMaskSize: "contain",
					maskImage: `url('${imagesBaseUri}/neontractor-logo.png')`,
					maskRepeat: "no-repeat",
					maskSize: "contain",
				}}
				className="group-hover:animate-bounce translate-y-0 transition-transform duration-500">
				<img src={imagesBaseUri + "/neontractor-logo.png"} alt="NeonTractor logo" className="h-16 mx-auto" />
			</div>
		</div>
	)
}

export default RooHero
