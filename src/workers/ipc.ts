/**
 * Framing and connecting. Workers talk to the parent over a unix socket
 * rather than the fork IPC channel, so they can outlive the run and be
 * adopted by the next one.
 */

import net from "node:net"

/** Newline-delimited JSON over a socket. The handler can be swapped later. */
export const frame = <In, Out>(socket: net.Socket): Workers.Framed<In, Out> => {
    let handler: (message: In) => void = () => {}
    let buffer = ""

    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
        buffer += chunk

        let index = buffer.indexOf("\n")

        while (index !== -1) {
            const line = buffer.slice(0, index)

            buffer = buffer.slice(index + 1)

            if (line) {
                handler(JSON.parse(line) as In)
            }

            index = buffer.indexOf("\n")
        }
    })

    return {
        send(message) {
            if (!socket.destroyed) {
                socket.write(`${JSON.stringify(message)}\n`)
            }
        },
        on(next) {
            handler = next
        },
    }
}

/**
 * Connect to a worker and wait for its greeting. Retries while the socket
 * is not there yet or nobody answers — a worker that is still starting, or
 * a leftover file — until the deadline.
 */
export const connect = <Out = unknown>(socketPath: string, timeout: number): Promise<Workers.Connection<Out>> =>
    new Promise((resolve, reject) => {
        const deadline = Date.now() + timeout

        const attempt = (): void => {
            const socket = net.connect(socketPath)

            socket.once("error", (error: NodeJS.ErrnoException) => {
                socket.destroy()

                if (Date.now() < deadline && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
                    setTimeout(attempt, 50)
                } else {
                    reject(error)
                }
            })

            socket.once("connect", () => {
                const io = frame<Workers.Reply, Out>(socket)
                const timer = setTimeout(() => {
                    socket.destroy()
                    reject(new Error("worker did not answer"))
                }, Math.max(1000, deadline - Date.now()))

                io.on((hello) => {
                    clearTimeout(timer)
                    resolve({ socket, io, hello })
                })
            })
        }

        attempt()
    })
