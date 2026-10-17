import { readFileSync } from "node:fs"
import { join } from "node:path"
import { crc32 } from "node:zlib"

/**
 * Pack integrations/vscode into a .vsix (a zip with a manifest) so editors' own
 * `--install-extension` can install it, without a vsce dependency.
 */

const FILES = ["package.json", "extension.js"]

function escape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function buildVsix(dir: string): Buffer {
	const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"))
	const entries: [string, Buffer][] = [
		[
			"extension.vsixmanifest",
			Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
	<Metadata>
		<Identity Language="en-US" Id="${escape(manifest.name)}" Version="${escape(manifest.version)}" Publisher="${escape(manifest.publisher)}"/>
		<DisplayName>${escape(manifest.displayName)}</DisplayName>
		<Description xml:space="preserve">${escape(manifest.description)}</Description>
	</Metadata>
	<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
	<Dependencies/>
	<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>
`),
		],
		[
			"[Content_Types].xml",
			Buffer.from(
				'<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
					'<Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/>' +
					'<Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>',
			),
		],
		...FILES.map((file): [string, Buffer] => [`extension/${file}`, readFileSync(join(dir, file))]),
	]
	return zip(entries)
}

/** A zip of stored (uncompressed) entries: all an installer needs for a few small files. */
export function zip(entries: [string, Buffer][]): Buffer {
	const locals: Buffer[] = []
	const centrals: Buffer[] = []
	let offset = 0
	for (const [name, data] of entries) {
		const nameBytes = Buffer.from(name)
		const crc = crc32(data)
		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4) // version needed
		local.writeUInt16LE(0x0800, 6) // UTF-8 names
		local.writeUInt16LE(0, 8) // stored
		local.writeUInt16LE(0, 10) // time
		local.writeUInt16LE(0x21, 12) // date: 1980-01-01
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(data.length, 18)
		local.writeUInt32LE(data.length, 22)
		local.writeUInt16LE(nameBytes.length, 26)
		local.writeUInt16LE(0, 28)
		const central = Buffer.alloc(46)
		central.writeUInt32LE(0x02014b50, 0)
		central.writeUInt16LE(20, 4) // version made by
		local.copy(central, 6, 4, 28) // version needed through name length
		central.writeUInt32LE(offset, 42)
		locals.push(local, nameBytes, data)
		centrals.push(central, nameBytes)
		offset += local.length + nameBytes.length + data.length
	}
	const directory = Buffer.concat(centrals)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(entries.length, 8)
	end.writeUInt16LE(entries.length, 10)
	end.writeUInt32LE(directory.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...locals, directory, end])
}
