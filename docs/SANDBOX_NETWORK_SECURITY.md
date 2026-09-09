# Sandbox install-network security

## Scope and threat model

Peephole builds untrusted public GitHub repositories. During `npm ci`, package
lifecycle scripts execute inside gVisor with `network: "sandbox"`. Those scripts
must be able to resolve package hosts and download public dependencies, but they
must not discover or contact the EC2 host, the VPC, cloud metadata, another
preview job, or other non-public networks. The later build phase remains
`network: "none"` and is outside this egress exception.

The firewall is enforced in the host kernel on each job's veth, outside the
guest process and gVisor network stack. Failure to create any mandatory IPv4 or
IPv6 rule aborts network setup and therefore the job; there is no unrestricted
fallback.

## Production packet flow

Each job receives a unique `/30` from `10.200.0.0/16`:

```text
gVisor process
  -> job network namespace (10.200.x.2)
  -> peer veth
  -> host veth (10.200.x.1, layer-2 next hop)
  -> host FORWARD policy
  -> POSTROUTING MASQUERADE on the host default uplink
  -> public Internet
```

The default gateway is a layer-2 next hop. A packet for a public registry still
has the registry address as its IP destination when it traverses `FORWARD`, so
dropping private destination ranges does not block the gateway or NAT. A packet
addressed to the gateway or any other address owned by the host takes `INPUT`
instead, which is why a separate INPUT policy is required.

## IPv4 policy and rule order

Every job has three uniquely named chains, selected by its host-side veth. The
hooks are inserted at position 1 so a permissive host-wide FORWARD rule cannot
bypass them. `iptables -w 5` serializes concurrent updates.

Outbound FORWARD chain, in evaluation order:

1. Accept UDP 53 to each exact resolver `/32` selected from the mounted
   resolver file.
2. Accept TCP 53 to those same exact resolver addresses.
3. Drop these destination ranges:

   - `0.0.0.0/8` — current-network and invalid/special destinations
   - `10.0.0.0/8` — RFC 1918 and all Peephole job `/30` networks
   - `100.64.0.0/10` — shared carrier-grade NAT space
   - `127.0.0.0/8` — loopback
   - `169.254.0.0/16` — link-local, including AWS metadata
   - `172.16.0.0/12` — RFC 1918
   - `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24` — protocol,
     documentation, and deprecated relay space
   - `192.168.0.0/16` — RFC 1918
   - `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24` — benchmark and
     documentation space
   - `224.0.0.0/4` — multicast
   - `240.0.0.0/4` — reserved, including limited broadcast

4. Accept remaining public IPv4 destinations.

The host INPUT chain repeats the exact DNS UDP/TCP 53 exceptions and then drops
everything else from that job veth. It protects the veth gateway and every host
address, including services bound to VPC interfaces. Services bound only to
`127.0.0.1` are already in the host network namespace and cannot be reached via
the sandbox's separate loopback; the INPUT rule is defense in depth for any
other host-bound path.

The return FORWARD chain accepts only `ESTABLISHED,RELATED` conntrack traffic
and drops everything else, preventing unsolicited traffic from being routed
into a job. MASQUERADE is installed only after all filter rules succeed.

## DNS on AWS and systemd-resolved

`resolveDnsConfig()` chooses the same resolver file for both the OCI bind mount
and firewall policy. If `/etc/resolv.conf` contains only a loopback stub such as
`127.0.0.53`, it selects systemd-resolved's uplink file at
`/run/systemd/resolve/resolv.conf`. Only syntactically valid, non-loopback IPv4
nameservers are passed into the firewall.

This matters on EC2 because the VPC Route 53 Resolver can appear as the
VPC-primary-CIDR-plus-two address or as `169.254.169.253`. Both are inside ranges
that are otherwise blocked. An exact resolver exception for UDP/TCP destination
port 53 is installed before the range drop. No other port to that IP is
permitted. If no usable IPv4 resolver can be found, production preflight reports
the problem and job network creation also refuses to proceed.

DNS resolution is permitted, not trusted as an authorization boundary. DNS
answers that resolve to private or link-local addresses remain blocked because
filtering occurs on the actual destination IP after routing/DNAT, independently
of the hostname used by the script.

## IPv6 policy

Peephole does not configure an IPv6 address, IPv6 default route, or IPv6 NAT for
the job namespace. Linux may nevertheless create interface-local IPv6 state,
so relying on absent configuration alone would be fragile. Mandatory
`ip6tables` hooks drop all INPUT and both directions of FORWARD traffic on the
job veth. There are therefore no IPv6 DNS exceptions or public IPv6 egress.
Production preflight requires `ip6tables`; inability to enforce this policy is
a startup/job setup failure, not a reason to enable unrestricted networking.

## Job and host isolation

All current and future job subnets are inside `10.200.0.0/16`, which is covered
by the outbound `10.0.0.0/8` drop. Job A therefore cannot route to job B even if
worker concurrency is raised above one. Independent return chains also reject
connections that were not established by their owning job.

The policy blocks the EC2 metadata address, VPC PostgreSQL and other internal
services, and services on host/VPC addresses. The Peephole API (`127.0.0.1:8787`),
artifact host (`127.0.0.1:8788`), and TLS ask service (`127.0.0.1:8790`) remain
isolated in the host namespace. Publicly exposed Internet endpoints remain
public by design.

## Setup, teardown, and verification

Chains are fully populated before their INPUT/FORWARD hooks are inserted, IPv6
deny rules follow, and MASQUERADE is last. The gVisor process is launched only
after setup returns successfully. On setup failure or normal teardown, Peephole
removes NAT, IPv6 hooks, IPv4 hooks, custom chains, the veth, the namespace, and
the subnet lease. Each cleanup action tolerates partial prior setup.

Unit tests validate exact commands and ordering. The opt-in real suite requires
a Linux host, root-equivalent networking privileges, `runsc`, `ip`, `iptables`,
`ip6tables`, and a prepared base rootfs:

```sh
sudo env PEEPHOLE_REAL_GVISOR_TESTS=1 npm test -- tests/realGvisorSandbox.test.ts
```

On an idle production worker, inspect active jobs without changing policy:

```sh
sudo ip netns list
sudo iptables -S INPUT
sudo iptables -S FORWARD
sudo iptables -t nat -S POSTROUTING
sudo ip6tables -S INPUT
sudo ip6tables -S FORWARD
sudo ip netns exec <namespace> ip route
sudo ip netns exec <namespace> ip -6 route
```

From a controlled malicious fixture, verify that npm registry downloads and DNS
work; TCP connections to the veth gateway, EC2 VPC addresses, another active
job's peer address, and `169.254.169.254` time out or fail; and the same probes
during the build phase fail because it still uses `network: "none"`.

## Remaining limitations

- Install scripts retain broad public IPv4 Internet access. Registry-only
  policy needs an authenticated package proxy or egress proxy; registry IP
  allowlisting is not stable or complete enough.
- DNS can be used for exfiltration through the configured resolver. The exact
  IP/port exception prevents it from becoming general private-network access,
  but a dedicated filtering resolver would reduce this channel.
- Public services, including a service intentionally exposed by Peephole, are
  reachable by public address. Application authentication and rate limits remain
  necessary.
- Host firewall policy and resolver configuration are privileged deployment
  inputs. Compromise of the worker host is outside this sandbox boundary.
- File-based subnet leases survive ordinary teardown but still need stale-lease
  reconciliation after a host/process crash.
