import { describe, expect, it } from "vitest"

import { isDefaultRoute, parseProcNetRoute } from "./support/procNetRoute"

const HEADER =
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT"

// 192.168.253.1 via 10.200.0.1 on vpph1, /32 -- in /proc/net/route's
// host-order (little-endian) hex.
const databaseLine =
  "vpph1\t01FDA8C0\t0100C80A\t0007\t0\t0\t0\tFFFFFFFF\t0\t0\t0"
const linkLine = "vpph1\t0000C80A\t00000000\t0001\t0\t0\t0\tFCFFFFFF\t0\t0\t0"

function table(...lines: string[]): string {
  return [HEADER, ...lines].join("\n") + "\n"
}

describe("parseProcNetRoute", () => {
  it("decodes an exact /32 route to the tenant database host", () => {
    expect(parseProcNetRoute(table(linkLine, databaseLine))).toEqual([
      {
        iface: "vpph1",
        destination: "10.200.0.0",
        gateway: "0.0.0.0",
        mask: "255.255.255.252",
        prefixLength: 30,
      },
      {
        iface: "vpph1",
        destination: "192.168.253.1",
        gateway: "10.200.0.1",
        mask: "255.255.255.255",
        prefixLength: 32,
      },
    ])
  })

  it.each([
    [
      "destination",
      "vpph1\t02FDA8C0\t0100C80A\t0007\t0\t0\t0\tFFFFFFFF\t0\t0\t0",
      { destination: "192.168.253.2" },
    ],
    [
      "gateway",
      "vpph1\t01FDA8C0\t0200C80A\t0007\t0\t0\t0\tFFFFFFFF\t0\t0\t0",
      { gateway: "10.200.0.2" },
    ],
    [
      "interface",
      "eth0\t01FDA8C0\t0100C80A\t0007\t0\t0\t0\tFFFFFFFF\t0\t0\t0",
      { iface: "eth0" },
    ],
    [
      "mask",
      "vpph1\t00FDA8C0\t0100C80A\t0007\t0\t0\t0\t00FFFFFF\t0\t0\t0",
      { mask: "255.255.255.0", prefixLength: 24 },
    ],
  ])("reports a wrong %s so an exact match fails", (_field, line, wrong) => {
    const [route] = parseProcNetRoute(table(line))

    expect(route).toMatchObject(wrong)
    expect(route).not.toEqual({
      iface: "vpph1",
      destination: "192.168.253.1",
      gateway: "10.200.0.1",
      mask: "255.255.255.255",
      prefixLength: 32,
    })
  })

  it("detects a default route by its all-zero mask", () => {
    const routes = parseProcNetRoute(
      table(
        databaseLine,
        "vpph1\t00000000\t0100C80A\t0003\t0\t0\t0\t00000000\t0\t0\t0",
      ),
    )

    expect(routes.filter(isDefaultRoute)).toEqual([
      {
        iface: "vpph1",
        destination: "0.0.0.0",
        gateway: "10.200.0.1",
        mask: "0.0.0.0",
        prefixLength: 0,
      },
    ])
  })

  it("does not treat a /32 or link route as a default route", () => {
    expect(
      parseProcNetRoute(table(linkLine, databaseLine)).filter(isDefaultRoute),
    ).toEqual([])
  })

  it("reports a non-contiguous mask as having no prefix length", () => {
    const [route] = parseProcNetRoute(
      table("vpph1\t01FDA8C0\t0100C80A\t0007\t0\t0\t0\tFF00FFFF\t0\t0\t0"),
    )

    expect(route?.prefixLength).toBeNull()
  })

  it("returns no routes for a header-only table", () => {
    expect(parseProcNetRoute(table())).toEqual([])
  })

  it.each([
    ["an empty table", ""],
    ["a missing header", `${databaseLine}\n`],
    ["a truncated line", table("vpph1\t01FDA8C0\t0100C80A")],
    [
      "a non-hex address",
      table("vpph1\tZZFDA8C0\t0100C80A\t0007\t0\t0\t0\tFFFFFFFF\t0\t0\t0"),
    ],
    [
      "a short address",
      table("vpph1\t1FDA8C0\t0100C80A\t0007\t0\t0\t0\tFFFFFFFF\t0\t0\t0"),
    ],
  ])("throws on %s instead of reporting no route", (_case, text) => {
    expect(() => parseProcNetRoute(text)).toThrow()
  })
})
