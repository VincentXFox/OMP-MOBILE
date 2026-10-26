import { describe, expect, test } from "bun:test";
import { decide } from "./policy.ts";

describe("policy engine", () => {
	test("чтение и диагностика — самостоятельно", () => {
		expect(decide("git status").decision).toBe("allow");
		expect(decide("systemctl --user is-active omp-pocket-gateway").decision).toBe("allow");
		expect(decide("curl -s http://127.0.0.1:8088/api/health").decision).toBe("allow");
	});

	test("необратимое — запрещено, а не «требует подтверждения»", () => {
		expect(decide("rm -rf / --no-preserve-root").decision).toBe("deny");
		expect(decide("mkfs.ext4 /dev/sda").decision).toBe("deny");
		expect(decide("git push --force origin master").decision).toBe("deny");
	});

	test("обратимое, но чувствительное — подтверждение", () => {
		expect(decide("systemctl --user restart omp-pocket-runtime").decision).toBe("confirm");
		expect(decide("git reset --hard HEAD~1").decision).toBe("confirm");
		expect(decide("rm -f ./tmp.log").decision).toBe("confirm");
	});

	test("незнакомая команда не разрешается молча", () => {
		expect(decide("myrare-tool --flag").decision).toBe("confirm");
	});

	test("описание шага политикой не ограничивается", () => {
		expect(decide("починил конфиг и перепроверил").decision).toBe("allow");
	});
});
