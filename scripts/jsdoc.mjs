// JSDoc coverage: every declaration at module level, plus every class,
// interface and object-literal member, must carry a `/** */` comment.
// Exits 1 and lists the offenders otherwise. `--json` prints them as JSON.
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import ts from "typescript"

/** The repository. */
const root = path.resolve(import.meta.dirname, "..")
/** Directories to scan. */
const roots = ["src", "types", "scripts"]

/** Every .ts and .mjs file under a directory. */
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)

    return entry.isDirectory() ? walk(full) : /\.(ts|mjs)$/.test(entry.name) ? [full] : []
})

/** Every file to scan. */
const files = roots.flatMap((name) => walk(path.join(root, name)))

/** Kinds that count as a symbol. */
const symbolic = new Set([
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration,
    ts.SyntaxKind.ModuleDeclaration,
    ts.SyntaxKind.VariableStatement,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.Constructor,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor,
    ts.SyntaxKind.PropertyDeclaration,
    ts.SyntaxKind.PropertySignature,
    ts.SyntaxKind.MethodSignature,
    ts.SyntaxKind.PropertyAssignment,
    ts.SyntaxKind.ShorthandPropertyAssignment,
])

/** A declaration's name, for the report. */
const name = (node) => {
    if (ts.isVariableStatement(node)) {
        return node.declarationList.declarations.map((d) => d.name.getText()).join(", ")
    }

    if (ts.isConstructorDeclaration(node)) {
        return "constructor"
    }

    return node.name?.getText() ?? "<anonymous>"
}

/** Whether a declaration carries a JSDoc comment. */
const documented = (node) => ts.getJSDocCommentsAndTags(node).length > 0

/** Undocumented declarations found so far. */
const missing = []
/** Declarations seen so far. */
let total = 0

/**
 * Descend into containers only: a module, a class body, an interface body,
 * a namespace, and object literals that initialize a module-level const.
 * Function bodies are not entered — locals are not symbols.
 */
const visit = (node, file, chain) => {
    if (symbolic.has(node.kind)) {
        total += 1

        if (!documented(node)) {
            const { line } = file.getLineAndCharacterOfPosition(node.getStart())

            missing.push({ file: path.relative(root, file.fileName), line: line + 1, symbol: [...chain, name(node)].join(".") })
        }
    }

    if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
            const init = declaration.initializer

            if (init && ts.isObjectLiteralExpression(init)) {
                visit(init, file, [...chain, declaration.name.getText()])
            }
        }

        return
    }

    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)) {
        visit(node.initializer, file, [...chain, name(node)])

        return
    }

    if (ts.isObjectLiteralExpression(node)) {
        node.properties.forEach((property) => visit(property, file, chain))

        return
    }

    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
        node.members.forEach((member) => visit(member, file, [...chain, name(node)]))

        return
    }

    if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
        node.body.statements.forEach((statement) => visit(statement, file, [...chain, name(node)]))

        return
    }

    if (ts.isSourceFile(node)) {
        node.statements.forEach((statement) => visit(statement, file, chain))
    }
}

for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)

    visit(source, source, [])
}

/** Declarations with a comment. */
const covered = total - missing.length
/** Coverage, for the report. */
const percent = total > 0 ? ((covered / total) * 100).toFixed(1) : "100.0"

if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ total, covered, missing }, null, 2)}\n`)
} else {
    for (const { file, line, symbol } of missing) {
        process.stdout.write(`${file}:${line}  ${symbol}\n`)
    }

    process.stdout.write(`jsdoc: ${covered}/${total} symbols documented (${percent}%)\n`)
}

process.exitCode = missing.length > 0 ? 1 : 0
