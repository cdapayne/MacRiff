#include <stdio.h>
#include <stdlib.h>
#include <ApplicationServices/ApplicationServices.h>

int main() {
    // Unbuffer stdin and stdout to achieve absolute minimum latency
    if (setvbuf(stdin, NULL, _IONBF, 0) != 0) {
        perror("setvbuf stdin");
    }
    if (setvbuf(stdout, NULL, _IONBF, 0) != 0) {
        perror("setvbuf stdout");
    }

    // Check and request Accessibility permissions with a system prompt
    CFStringRef keys[] = { CFSTR("AXTrustedToRequirePrompt") };
    CFTypeRef values[] = { kCFBooleanTrue };
    CFDictionaryRef options = CFDictionaryCreate(kCFAllocatorDefault, 
                                                 (const void **)keys, 
                                                 (const void **)values, 
                                                 1, 
                                                 &kCFCopyStringDictionaryKeyCallBacks, 
                                                 &kCFTypeDictionaryValueCallBacks);
    Boolean isTrusted = AXIsProcessTrustedWithOptions(options);
    CFRelease(options);

    if (!isTrusted) {
        fprintf(stderr, "\n[Warning] Accessibility permissions are NOT enabled for the calling application. Virtual key injection will fail silently!\n");
        fprintf(stderr, "A system prompt has been requested. Please enable this app (or terminal/VS Code) in System Settings > Privacy & Security > Accessibility and restart.\n\n");
    }

    char type;
    int val1;
    int val2;

    // Read loop: type prefix ('K' = keyboard, 'S' = scroll) and arguments
    while (scanf(" %c", &type) == 1) {
        if (type == 'K') {
            if (scanf("%d %d", &val1, &val2) == 2) {
                fprintf(stderr, "[Injector Debug] Keyboard event: keycode %d state %d\n", val1, val2);
                CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
                if (!source) {
                    fprintf(stderr, "Failed to create CGEventSource\n");
                    continue;
                }
                CGEventRef event = CGEventCreateKeyboardEvent(source, (CGKeyCode)val1, val2 ? true : false);
                if (!event) {
                    fprintf(stderr, "Failed to create CGEvent for keycode %d\n", val1);
                    CFRelease(source);
                    continue;
                }
                CGEventPost(kCGHIDEventTap, event);
                CFRelease(event);
                CFRelease(source);
            }
        } else if (type == 'S') {
            if (scanf("%d", &val1) == 1) {
                fprintf(stderr, "[Injector Debug] Scroll event: delta %d\n", val1);
                CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 1, val1);
                if (!event) {
                    fprintf(stderr, "Failed to create CGScrollEvent for delta %d\n", val1);
                    continue;
                }
                CGEventPost(kCGHIDEventTap, event);
                CFRelease(event);
            }
        }
    }

    return 0;
}
